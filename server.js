const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ABC API Config
const ABC_API_BASE = 'https://api.abcfinancial.com/rest';
const ABC_APP_ID = process.env.ABC_APP_ID;
const ABC_APP_KEY = process.env.ABC_APP_KEY;

// Location mapping: ABC Club Number -> GHL Location ID & Token
const LOCATIONS = {
  '31601': {
    ghlLocationId: 'BQfUepBFzqVan4ruCQ6R',
    ghlToken: process.env.GHL_TOKEN_31601
  },
  '31600': {
    ghlLocationId: 'aqSDfuZLimMXuPz6Zx3p',
    ghlToken: process.env.GHL_TOKEN_31600
  }
};

// Target campaigns
const TARGET_CAMPAIGNS = ['Non-Member Program', 'PHYSICAL THERAPY'];

// Campaign to tag mapping
const CAMPAIGN_TAGS = {
  'PHYSICAL THERAPY': 'NLPT',
  'Non-Member Program': 'Non Member Program'
};

// GHL custom field key for ABC ID
const ABC_ID_FIELD_KEY = 'abc_member_id';

// In-memory tracking of synced members (resets on restart)
const syncedMemberIds = new Set();

// Polling interval (60 seconds to avoid rate limits)
const POLL_INTERVAL = 60000;

// Get today's date in YYYY-MM-DD format
function getTodayDate() {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

// ABC API: Get members/prospects for a club
async function getAbcProspects(clubNumber) {
  const today = getTodayDate();
  
  try {
    const response = await axios.get(
      `${ABC_API_BASE}/${clubNumber}/members`,
      {
        headers: {
          'accept': 'application/json',
          'app_id': ABC_APP_ID,
          'app_key': ABC_APP_KEY
        },
        params: {
          joinStatus: 'Prospect',
          createdTimestampRange: today
        }
      }
    );
    
    return response.data.members || [];
  } catch (error) {
    console.error(`[ABC] Error fetching prospects for club ${clubNumber}:`, error.response?.data || error.message);
    return [];
  }
}

// Filter prospects by campaign and entry source
function filterProspects(prospects) {
  return prospects.filter(prospect => {
    // Check entry source - look in multiple possible locations
    const entrySource = prospect.agreementEntrySource || 
                        prospect.agreement?.agreementEntrySource ||
                        prospect.agreement?.entrySource;
    const entrySourceReport = prospect.agreementEntrySourceReportName || 
                              prospect.agreement?.agreementEntrySourceReportName ||
                              prospect.agreement?.entrySourceReportName;
    
    const isValidEntrySource = 
      entrySource === 'DataTrak Fast Add' || 
      entrySourceReport === 'Fast Add';
    
    if (!isValidEntrySource) return false;
    
    // Check campaign - look in multiple possible locations
    const campaign = prospect.campaign || 
                     prospect.campaignName || 
                     prospect.agreement?.campaign ||
                     prospect.agreement?.campaignName;
    const isValidCampaign = TARGET_CAMPAIGNS.includes(campaign);
    
    return isValidCampaign;
  });
}

// GHL API: Search for existing contact by email
async function searchGhlContactByEmail(email, locationId, token) {
  if (!email) return null;
  
  try {
    const response = await axios.get(
      'https://services.leadconnectorhq.com/contacts/',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        },
        params: {
          locationId: locationId,
          query: email
        }
      }
    );
    
    const contacts = response.data.contacts || [];
    return contacts.find(c => c.email?.toLowerCase() === email.toLowerCase()) || null;
  } catch (error) {
    console.error(`[GHL] Error searching contact by email:`, error.response?.data || error.message);
    return null;
  }
}

// GHL API: Search for existing contact by ABC ID
async function searchGhlContactByAbcId(abcId, locationId, token) {
  try {
    const response = await axios.get(
      'https://services.leadconnectorhq.com/contacts/',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        },
        params: {
          locationId: locationId,
          query: abcId.toString()
        }
      }
    );
    
    const contacts = response.data.contacts || [];
    // Check custom field for ABC ID match
    return contacts.find(c => {
      const customFields = c.customFields || [];
      return customFields.some(cf => 
        cf.key === ABC_ID_FIELD_KEY && cf.value === abcId.toString()
      );
    }) || null;
  } catch (error) {
    console.error(`[GHL] Error searching contact by ABC ID:`, error.response?.data || error.message);
    return null;
  }
}

// GHL API: Create contact
async function createGhlContact(prospect, locationId, token, campaign) {
  const tag = CAMPAIGN_TAGS[campaign];
  
  // Get personal info - check nested structure
  const personal = prospect.personal || {};
  const firstName = prospect.firstName || personal.firstName || '';
  const lastName = prospect.lastName || personal.lastName || '';
  const email = prospect.email || personal.email || '';
  const phone = prospect.homePhone || prospect.cellPhone || prospect.workPhone || 
                personal.homePhone || personal.cellPhone || personal.workPhone || '';
  const memberId = prospect.memberId || prospect.id || '';
  
  // Must have at least email or phone to create contact
  if (!email && !phone) {
    console.log(`[GHL] Skipping contact creation - no email or phone for ${firstName} ${lastName} (${memberId})`);
    return null;
  }
  
  // Build contact data - only include email if it's valid
  const contactData = {
    locationId: locationId,
    firstName: firstName,
    lastName: lastName,
    phone: phone,
    tags: tag ? [tag] : [],
    customFields: [
      {
        key: ABC_ID_FIELD_KEY,
        value: memberId.toString()
      }
    ]
  };
  
  // Only add email if it looks valid
  if (email && email.includes('@')) {
    contactData.email = email;
  }
  
  try {
    const response = await axios.post(
      'https://services.leadconnectorhq.com/contacts/',
      contactData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`[GHL] Created contact: ${contactData.firstName} ${contactData.lastName} (${contactData.email || 'no email'}, ${contactData.phone || 'no phone'}) with tag: ${tag}`);
    return response.data;
  } catch (error) {
    console.error(`[GHL] Error creating contact:`, error.response?.data || error.message);
    return null;
  }
}

// Main sync function for a single club
async function syncClub(clubNumber) {
  const locationConfig = LOCATIONS[clubNumber];
  if (!locationConfig) {
    console.error(`[SYNC] No configuration found for club ${clubNumber}`);
    return;
  }
  
  const { ghlLocationId, ghlToken } = locationConfig;
  
  console.log(`[SYNC] Polling club ${clubNumber}...`);
  
  // Get prospects from ABC
  const allProspects = await getAbcProspects(clubNumber);
  console.log(`[SYNC] Found ${allProspects.length} total prospects for today`);
  
  // Filter by campaign and entry source
  const filteredProspects = filterProspects(allProspects);
  console.log(`[SYNC] ${filteredProspects.length} prospects match criteria`);
  
  for (const prospect of filteredProspects) {
    const memberId = prospect.memberId || prospect.id;
    const campaign = prospect.campaign || prospect.campaignName || 
                     prospect.agreement?.campaign || prospect.agreement?.campaignName;
    
    // Skip if already synced this session
    if (syncedMemberIds.has(memberId)) {
      console.log(`[SYNC] Skipping ${memberId} - already synced this session`);
      continue;
    }
    
    // Get email for duplicate check
    const email = prospect.email || prospect.personal?.email;
    
    // Check for duplicate by email
    if (email) {
      const existingByEmail = await searchGhlContactByEmail(
        email, 
        ghlLocationId, 
        ghlToken
      );
      
      if (existingByEmail) {
        console.log(`[SYNC] Skipping ${memberId} - email already exists in GHL`);
        syncedMemberIds.add(memberId);
        continue;
      }
    }
    
    // Check for duplicate by ABC ID
    const existingByAbcId = await searchGhlContactByAbcId(
      memberId, 
      ghlLocationId, 
      ghlToken
    );
    
    if (existingByAbcId) {
      console.log(`[SYNC] Skipping ${memberId} - ABC ID already exists in GHL`);
      syncedMemberIds.add(memberId);
      continue;
    }
    
    // Create contact in GHL
    const created = await createGhlContact(prospect, ghlLocationId, ghlToken, campaign);
    
    if (created) {
      syncedMemberIds.add(memberId);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// Main polling function
async function pollAllClubs() {
  console.log(`\n[POLL] Starting poll cycle at ${new Date().toISOString()}`);
  
  for (const clubNumber of Object.keys(LOCATIONS)) {
    await syncClub(clubNumber);
    // Add delay between clubs to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log(`[POLL] Poll cycle complete. Synced members tracked: ${syncedMemberIds.size}`);
}

// Clear synced IDs at midnight (new day = new prospects)
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  
  const msUntilMidnight = midnight - now;
  
  setTimeout(() => {
    console.log('[RESET] Midnight - clearing synced member IDs');
    syncedMemberIds.clear();
    scheduleMidnightReset(); // Schedule next reset
  }, msUntilMidnight);
  
  console.log(`[RESET] Scheduled midnight reset in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    syncedCount: syncedMemberIds.size,
    pollInterval: `${POLL_INTERVAL / 1000} seconds`,
    lastPoll: new Date().toISOString(),
    locations: Object.keys(LOCATIONS)
  });
});

// Manual trigger endpoint
app.get('/trigger', async (req, res) => {
  await pollAllClubs();
  res.json({ 
    status: 'Poll triggered',
    syncedCount: syncedMemberIds.size 
  });
});

// DEBUG: See raw prospect data structure
app.get('/debug/:clubNumber', async (req, res) => {
  const clubNumber = req.params.clubNumber;
  console.log(`[DEBUG] Fetching sample prospects for club ${clubNumber}`);
  
  const prospects = await getAbcProspects(clubNumber);
  
  // Return first 3 prospects with full structure
  const samples = prospects.slice(0, 3).map(p => ({
    // Top level fields
    memberId: p.memberId,
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    campaign: p.campaign,
    campaignName: p.campaignName,
    agreementEntrySource: p.agreementEntrySource,
    agreementEntrySourceReportName: p.agreementEntrySourceReportName,
    // Nested personal
    personal: p.personal,
    // Nested agreement
    agreement: p.agreement,
    // All keys at top level
    allTopLevelKeys: Object.keys(p)
  }));
  
  res.json({
    totalProspects: prospects.length,
    sampleCount: samples.length,
    samples: samples
  });
});

// DEBUG: Test filter on actual data
app.get('/debug-filter/:clubNumber', async (req, res) => {
  const clubNumber = req.params.clubNumber;
  console.log(`[DEBUG] Testing filter for club ${clubNumber}`);
  
  const prospects = await getAbcProspects(clubNumber);
  
  // Check each prospect and show why it passed or failed
  const analysis = prospects.slice(0, 20).map(p => {
    const entrySource = p.agreementEntrySource || 
                        p.agreement?.agreementEntrySource ||
                        p.agreement?.entrySource;
    const entrySourceReport = p.agreementEntrySourceReportName || 
                              p.agreement?.agreementEntrySourceReportName ||
                              p.agreement?.entrySourceReportName;
    const campaign = p.campaign || 
                     p.campaignName || 
                     p.agreement?.campaign ||
                     p.agreement?.campaignName;
    
    const isValidEntrySource = entrySource === 'DataTrak Fast Add' || entrySourceReport === 'Fast Add';
    const isValidCampaign = TARGET_CAMPAIGNS.includes(campaign);
    
    return {
      memberId: p.memberId || p.id,
      name: `${p.firstName || p.personal?.firstName || ''} ${p.lastName || p.personal?.lastName || ''}`,
      entrySource,
      entrySourceReport,
      campaign,
      passesEntrySource: isValidEntrySource,
      passesCampaign: isValidCampaign,
      wouldSync: isValidEntrySource && isValidCampaign
    };
  });
  
  const filtered = filterProspects(prospects);
  
  res.json({
    totalProspects: prospects.length,
    matchingFilter: filtered.length,
    targetCampaigns: TARGET_CAMPAIGNS,
    requiredEntrySource: 'DataTrak Fast Add / Fast Add',
    analysis: analysis
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[SERVER] ABC-GHL Prospect Sync running on port ${PORT}`);
  console.log(`[SERVER] Polling every ${POLL_INTERVAL / 1000} seconds`);
  console.log(`[SERVER] Monitoring clubs: ${Object.keys(LOCATIONS).join(', ')}`);
  
  // Schedule midnight reset
  scheduleMidnightReset();
  
  // Initial poll
  pollAllClubs();
  
  // Start polling interval
  setInterval(pollAllClubs, POLL_INTERVAL);
});
