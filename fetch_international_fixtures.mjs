#!/usr/bin/env node
// Pulls upcoming international football fixtures from TheSportsDB and
// prints them as tab-separated rows matching the Google Sheet's exact
// column layout (Date, Host Country, Stadium/Venue, Home Team, Home
// Jersey, Home Jersey Image, Home Score, Away Score, Away Jersey, Away
// Jersey Image URL, Away Team, Competition, Stage, Notes, Home
// Penalties, Away Penalties) - paste the output straight into the
// sheet above your most recent row. Jersey/image/score/penalty columns
// are left blank on purpose - those still need a human: an actual
// jersey photo to source, and the real score once the match is played.
//
// Usage:
//   node fetch_international_fixtures.mjs
//   TSDB_KEY=<your Premium key> node fetch_international_fixtures.mjs
//
// There's no personal key on the free tier - per TheSportsDB's own
// docs (thesportsdb.com/documentation#authentication), "123" IS the
// free API key, shared by every free user. Rate limiting is 30
// requests/minute, but since that's shared globally (not per-user),
// how fast this actually runs depends on how much other traffic is
// hitting it at the same time - hence the retry-with-backoff below
// rather than just giving up on a 429. If this turns out too
// unreliable in practice, a $9/month Premium key (your own, not
// shared) is the fallback - set it via TSDB_KEY.
//
// How it works: TheSportsDB indexes national teams individually (not
// as one big "all internationals" list), so this fetches every team
// under the major FIFA/confederation competitions, de-duplicates them
// (most teams show up under several - World Cup, their own
// confederation's qualifiers, continental cup, Nations League,
// friendlies), then asks each team for its own next fixture(s) and
// merges the results (a fixture is returned once per team playing in
// it, so de-duplicated again by event id at the end).
//
// This is meant to run once per international window, not
// continuously - a full run can take anywhere from ~10 minutes to
// much longer depending on shared rate-limit pressure from other
// free-tier users at the time.

const KEY = process.env.TSDB_KEY || '123';
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
// 2100ms keeps us at ~28.5/min on our own - the retry logic in getJson
// handles the rest when the shared 30/min pool is under pressure from
// other free users.
const DELAY_MS = 2100;
const MAX_RETRIES = 6;

// The competitions whose team lists between them cover essentially
// every FIFA member association - World Cup qualifying is run per
// confederation, so all six plus the big continental cups and the two
// global tournaments.
const SEED_LEAGUES = [
  'FIFA World Cup',
  'World Cup Qualifying UEFA',
  'World Cup Qualifying CONMEBOL',
  'World Cup Qualifying CONCACAF',
  'World Cup Qualifying AFC',
  'World Cup Qualifying CAF',
  'World Cup Qualifying OFC',
  'UEFA European Championships',
  'Copa America',
  'Africa Cup of Nations',
  'AFC Asian Cup',
  'CONCACAF Gold Cup',
  'OFC Nations Cup',
  'UEFA Nations League',
  'International Friendlies',
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Retries a 429 (rate limited) or 5xx (transient server error) with
// growing backoff instead of giving up on that one team/league - the
// free key's 30/min limit is shared across every free user, so a 429
// here often just means someone else's traffic, not that we're over
// our own budget.
async function getJson(url){
  for(let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    let res;
    try {
      res = await fetch(url);
    } catch(e){
      if(attempt === MAX_RETRIES) throw e;
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if(res.status === 429 || res.status >= 500){
      if(attempt === MAX_RETRIES) throw new Error(`${res.status} ${res.statusText} for ${url} (gave up after ${MAX_RETRIES} retries)`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = retryAfter ? retryAfter * 1000 : 3000 * (attempt + 1);
      console.error(`  ...${res.status}, waiting ${Math.round(waitMs/1000)}s before retrying`);
      await sleep(waitMs);
      continue;
    }
    if(!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  }
}

async function collectTeamIds(){
  const ids = new Map(); // id -> team name, for progress output only
  for(const league of SEED_LEAGUES){
    await sleep(DELAY_MS);
    let data;
    try {
      data = await getJson(`${BASE}/search_all_teams.php?l=${encodeURIComponent(league)}`);
    } catch(e){
      console.error(`! couldn't fetch teams for ${league}: ${e.message}`);
      continue;
    }
    const teams = data.teams || [];
    teams.forEach(t => ids.set(t.idTeam, t.strTeam));
    console.error(`  ${league}: ${teams.length} teams (${ids.size} unique so far)`);
  }
  return ids;
}

async function collectFixtures(teamIds){
  const events = new Map(); // idEvent -> event
  let i = 0;
  for(const [id, name] of teamIds){
    i++;
    await sleep(DELAY_MS);
    let data;
    try {
      data = await getJson(`${BASE}/eventsnext.php?id=${id}`);
    } catch(e){
      console.error(`! couldn't fetch fixtures for ${name} (${id}): ${e.message}`);
      continue;
    }
    (data.events || []).forEach(ev => events.set(ev.idEvent, ev));
    if(i % 20 === 0) console.error(`  ...${i}/${teamIds.size} teams checked, ${events.size} fixtures found so far`);
  }
  return [...events.values()];
}

function formatDate(ymd){
  const [y, m, d] = ymd.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m-1]} ${d}, ${y}`;
}

function toRow(ev){
  return [
    formatDate(ev.dateEvent),      // Date
    ev.strCountry || '',           // Host Country
    ev.strVenue || '',             // Stadium/Venue
    ev.strHomeTeam || '',          // Home Team
    '',                            // Home Jersey
    '',                            // Home Jersey Image
    '',                            // Home Score
    '',                            // Away Score
    '',                            // Away Jersey
    '',                            // Away Jersey Image URL
    ev.strAwayTeam || '',          // Away Team
    ev.strLeague || '',            // Competition
    '',                            // Stage
    '',                            // Notes
    '',                            // Home Penalties
    '',                            // Away Penalties
  ].join('\t');
}

async function main(){
  if(KEY === '123'){
    console.error('Using the free API key (123, shared by all free users) - if this run hits a lot of rate-limit waits, that\'s other people\'s traffic, not yours. It\'ll keep retrying rather than give up.\n');
  }
  console.error('Collecting national team list...');
  const teamIds = await collectTeamIds();
  console.error(`\n${teamIds.size} unique national teams found. Fetching upcoming fixtures...\n`);
  const fixtures = await collectFixtures(teamIds);
  fixtures.sort((a, b) => (a.dateEvent || '').localeCompare(b.dateEvent || '') || (a.strTime || '').localeCompare(b.strTime || ''));
  console.error(`\n${fixtures.length} upcoming fixtures found. Paste the lines below into the sheet.\n`);
  for(const ev of fixtures) console.log(toRow(ev));
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
