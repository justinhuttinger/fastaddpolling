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

// Polling interval (15 seconds)
const POLL_INTERVAL = 15000;

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
          creationDateRangeStart: today,
          creationDateRangeEnd: today,
          type: 'Prospect'
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
    // Check entry source
    const entrySource = prospect.agreementEntrySource;
    const entrySourceReport = prospect.agreementEntrySourceReportName;
    
    const isValidEntrySource = 
      entrySource === 'DataTrak Fast Add' || 
      entrySourceReport === 'Fast Add';
    
    if (!isValidEntrySource) return false;
    
    // Check campaign
    const campaign = prospect.campaign || prospect.campaignName;
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
  
  const contactData = {
    locationId: locationId,
    firstName: prospect.firstName || '',
    lastName: prospect.lastName || '',
    email: prospect.email || '',
    phone: prospect.homePhone || prospect.cellPhone || prospect.workPhone || '',
    tags: tag ? [tag] : [],
    customFields: [
      {
        key: ABC_ID_FIELD_KEY,
        value: prospect.memberId?.toString() || ''
      }
    ]
  };
  
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
    
    console.log(`[GHL] Created contact: ${contactData.firstName} ${contactData.lastName} (${contactData.email}) with tag: ${tag}`);
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
    const memberId = prospect.memberId;
    const campaign = prospect.campaign || prospect.campaignName;
    
    // Skip if already synced this session
    if (syncedMemberIds.has(memberId)) {
      console.log(`[SYNC] Skipping ${memberId} - already synced this session`);
      continue;
    }
    
    // Check for duplicate by email
    if (prospect.email) {
      const existingByEmail = await searchGhlContactByEmail(
        prospect.email, 
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
