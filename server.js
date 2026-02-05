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

// ═══════════════════════════════════════════
// SWIM POS CONFIG (Club 31600 - Clackamas)
// ═══════════════════════════════════════════
const SWIM_CLUB = '31600';
const SWIM_PROFIT_CENTERS = [
  'Swim Club',
  'Group Swim Lessons',
  'Private Swim Lessons'
];
const SWIM_TAG = 'swim purchased';

// In-memory tracking of synced swim transaction IDs (resets on restart)
const syncedSwimTransactionIds = new Set();

// Polling interval (60 seconds to avoid rate limits)
const POLL_INTERVAL = 60000;

// Get today's date in YYYY-MM-DD format
function getTodayDate() {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

// ═══════════════════════════════════════════
// EXISTING PROSPECT SYNC FUNCTIONS
// ═══════════════════════════════════════════

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
  // ABC uses primaryPhone and mobilePhone in the personal object
  const phone = personal.primaryPhone || personal.mobilePhone || 
                prospect.primaryPhone || prospect.mobilePhone ||
                prospect.homePhone || prospect.cellPhone || '';
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

// ═══════════════════════════════════════════
// SWIM POS SYNC FUNCTIONS (Club 31600 only)
// ═══════════════════════════════════════════

// ABC API: Get POS Transactions
async function getPosTransactions(clubNumber) {
  const today = getTodayDate();

  try {
    const response = await axios.get(
      `${ABC_API_BASE}/${clubNumber}/clubs/transactions/pos`,
      {
        headers: {
          'accept': 'application/json',
          'app_id': ABC_APP_ID,
          'app_key': ABC_APP_KEY
        },
        params: {
          transactionTimestampRange: today
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error(`[SWIM] Error fetching POS transactions for club ${clubNumber}:`, error.response?.data || error.message);
    return {};
  }
}

// Extract transactions from ABC POS response (nested under clubs[0].transactions)
function extractTransactions(data) {
  try {
    const clubs = data.clubs || [];
    if (clubs.length === 0) return [];
    const transactions = clubs[0].transactions || [];
    return Array.isArray(transactions) ? transactions : [];
  } catch (e) {
    console.error('[SWIM] Error extracting transactions:', e.message);
    return [];
  }
}

// Extract items from a transaction (nested under items.item)
function extractItems(transaction) {
  const itemsWrapper = transaction.items || {};
  const items = itemsWrapper.item || [];
  return Array.isArray(items) ? items : [items];
}

// ABC API: Get member by ID
async function getAbcMember(clubNumber, memberId) {
  try {
    const response = await axios.get(
      `${ABC_API_BASE}/${clubNumber}/members/${memberId}`,
      {
        headers: {
          'accept': 'application/json',
          'app_id': ABC_APP_ID,
          'app_key': ABC_APP_KEY
        }
      }
    );

    const members = response.data.members || [];
    return members[0] || null;
  } catch (error) {
    console.error(`[SWIM] Error fetching member ${memberId}:`, error.response?.data || error.message);
    return null;
  }
}

// GHL API: Add tag to existing contact
async function addTagToGhlContact(contactId, tag, token) {
  try {
    const response = await axios.put(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        tags: [tag]
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[SWIM] Added tag "${tag}" to existing contact ${contactId}`);
    return response.data;
  } catch (error) {
    console.error(`[SWIM] Error adding tag to contact ${contactId}:`, error.response?.data || error.message);
    return null;
  }
}

// GHL API: Create contact for swim sale
async function createGhlSwimContact(member, locationId, token) {
  const personal = member.personal || {};
  const firstName = personal.firstName || '';
  const lastName = personal.lastName || '';
  const email = personal.email || '';
  const phone = personal.primaryPhone || personal.mobilePhone || '';
  const memberId = member.memberId || '';

  if (!email && !phone) {
    console.log(`[SWIM] Skipping contact creation - no email or phone for ${firstName} ${lastName} (${memberId})`);
    return null;
  }

  const contactData = {
    locationId: locationId,
    firstName: firstName,
    lastName: lastName,
    phone: phone,
    tags: [SWIM_TAG],
    customFields: [
      {
        key: ABC_ID_FIELD_KEY,
        value: memberId.toString()
      }
    ]
  };

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

    console.log(`[SWIM] Created contact: ${firstName} ${lastName} (${email || 'no email'}) with tag: ${SWIM_TAG}`);
    return response.data;
  } catch (error) {
    console.error(`[SWIM] Error creating swim contact:`, error.response?.data || error.message);
    return null;
  }
}

// Main swim sync function
async function syncSwimSales() {
  const locationConfig = LOCATIONS[SWIM_CLUB];
  if (!locationConfig) {
    console.error(`[SWIM] No configuration found for club ${SWIM_CLUB}`);
    return;
  }

  const { ghlLocationId, ghlToken } = locationConfig;

  console.log(`[SWIM] Polling POS transactions for club ${SWIM_CLUB}...`);

  // Get today's POS transactions
  const data = await getPosTransactions(SWIM_CLUB);
  const transactions = extractTransactions(data);
  console.log(`[SWIM] Found ${transactions.length} total POS transactions for today`);

  let swimCount = 0;
  let skippedReturns = 0;
  let skippedAlreadySynced = 0;
  let created = 0;
  let tagged = 0;

  for (const tx of transactions) {
    // Skip returns
    if (tx.return === 'true' || tx.return === true) {
      const items = extractItems(tx);
      const hasSwim = items.some(item => SWIM_PROFIT_CENTERS.includes(item.profitCenter));
      if (hasSwim) skippedReturns++;
      continue;
    }

    // Check for swim items
    const items = extractItems(tx);
    const swimItems = items.filter(item =>
      SWIM_PROFIT_CENTERS.includes(item.profitCenter)
    );

    if (swimItems.length === 0) continue;

    swimCount++;
    const txId = tx.transactionId;

    // Skip if already synced this session
    if (syncedSwimTransactionIds.has(txId)) {
      skippedAlreadySynced++;
      continue;
    }

    // Look up member details from ABC
    const member = await getAbcMember(SWIM_CLUB, tx.memberId);
    if (!member) {
      console.error(`[SWIM] Could not fetch member ${tx.memberId} - skipping`);
      syncedSwimTransactionIds.add(txId);
      continue;
    }

    const personal = member.personal || {};
    const email = personal.email || '';
    const memberId = member.memberId || '';

    // Check for existing contact by email
    let existingContact = null;
    if (email) {
      existingContact = await searchGhlContactByEmail(email, ghlLocationId, ghlToken);
    }

    // If not found by email, check by ABC ID
    if (!existingContact) {
      existingContact = await searchGhlContactByAbcId(memberId, ghlLocationId, ghlToken);
    }

    if (existingContact) {
      // Contact exists - just add the swim tag
      await addTagToGhlContact(existingContact.id, SWIM_TAG, ghlToken);
      tagged++;
    } else {
      // Contact doesn't exist - create with swim tag
      await createGhlSwimContact(member, ghlLocationId, ghlToken);
      created++;
    }

    syncedSwimTransactionIds.add(txId);

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log(`[SWIM] Summary: ${swimCount} swim transactions found, ${created} contacts created, ${tagged} contacts tagged, ${skippedReturns} returns skipped, ${skippedAlreadySynced} already synced`);
}

// ═══════════════════════════════════════════
// MAIN POLLING FUNCTION
// ═══════════════════════════════════════════

// Main polling function
async function pollAllClubs() {
  console.log(`\n[POLL] Starting poll cycle at ${new Date().toISOString()}`);
  
  // Existing prospect sync for all clubs
  for (const clubNumber of Object.keys(LOCATIONS)) {
    await syncClub(clubNumber);
    // Add delay between clubs to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Swim POS sync for club 31600
  await syncSwimSales();
  
  console.log(`[POLL] Poll cycle complete. Synced prospects: ${syncedMemberIds.size} | Synced swim txns: ${syncedSwimTransactionIds.size}`);
}

// Clear synced IDs at midnight (new day = new prospects/transactions)
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  
  const msUntilMidnight = midnight - now;
  
  setTimeout(() => {
    console.log('[RESET] Midnight - clearing synced IDs');
    syncedMemberIds.clear();
    syncedSwimTransactionIds.clear();
    scheduleMidnightReset(); // Schedule next reset
  }, msUntilMidnight);
  
  console.log(`[RESET] Scheduled midnight reset in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);
}

// ═══════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    syncedProspectCount: syncedMemberIds.size,
    syncedSwimTxCount: syncedSwimTransactionIds.size,
    pollInterval: `${POLL_INTERVAL / 1000} seconds`,
    lastPoll: new Date().toISOString(),
    locations: Object.keys(LOCATIONS),
    swimClub: SWIM_CLUB,
    swimProfitCenters: SWIM_PROFIT_CENTERS
  });
});

// Manual trigger endpoint
app.get('/trigger', async (req, res) => {
  await pollAllClubs();
  res.json({ 
    status: 'Poll triggered',
    syncedProspectCount: syncedMemberIds.size,
    syncedSwimTxCount: syncedSwimTransactionIds.size
  });
});

// Manual trigger for swim only
app.get('/trigger-swim', async (req, res) => {
  await syncSwimSales();
  res.json({
    status: 'Swim sync triggered',
    syncedSwimTxCount: syncedSwimTransactionIds.size
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

// DEBUG: See today's swim POS transactions
app.get('/debug-swim', async (req, res) => {
  console.log(`[DEBUG] Fetching swim POS data for club ${SWIM_CLUB}`);

  const data = await getPosTransactions(SWIM_CLUB);
  const transactions = extractTransactions(data);

  const swimSales = [];
  let skippedReturns = 0;

  transactions.forEach(tx => {
    if (tx.return === 'true' || tx.return === true) {
      const items = extractItems(tx);
      if (items.some(item => SWIM_PROFIT_CENTERS.includes(item.profitCenter))) skippedReturns++;
      return;
    }

    const items = extractItems(tx);
    const swimItems = items.filter(item =>
      SWIM_PROFIT_CENTERS.includes(item.profitCenter)
    );

    if (swimItems.length > 0) {
      swimSales.push({
        transactionId: tx.transactionId,
        transactionTimestamp: tx.transactionTimestamp,
        memberId: tx.memberId,
        alreadySynced: syncedSwimTransactionIds.has(tx.transactionId),
        swimItems: swimItems.map(item => ({
          name: item.name,
          profitCenter: item.profitCenter,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          subtotal: item.subtotal
        }))
      });
    }
  });

  res.json({
    club: SWIM_CLUB,
    date: getTodayDate(),
    totalTransactions: transactions.length,
    swimTransactionsFound: swimSales.length,
    returnsSkipped: skippedReturns,
    syncedSwimTxCount: syncedSwimTransactionIds.size,
    transactions: swimSales
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[SERVER] ABC-GHL Prospect + Swim Sync running on port ${PORT}`);
  console.log(`[SERVER] Polling every ${POLL_INTERVAL / 1000} seconds`);
  console.log(`[SERVER] Prospect sync clubs: ${Object.keys(LOCATIONS).join(', ')}`);
  console.log(`[SERVER] Swim POS sync club: ${SWIM_CLUB} (${SWIM_PROFIT_CENTERS.join(', ')})`);
  
  // Schedule midnight reset
  scheduleMidnightReset();
  
  // Initial poll
  pollAllClubs();
  
  // Start polling interval
  setInterval(pollAllClubs, POLL_INTERVAL);
});
