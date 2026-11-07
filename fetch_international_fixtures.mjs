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
//   TSDB_KEY=<your free key> node fetch_international_fixtures.mjs
//
// Get a free key at https://www.thesportsdb.com/free_sports_api - the
// shared public test key ("123") works but visibly samples/limits
// results rather than returning everything, so this will undercount
// fixtures without your own key.
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
// Rate-limited to stay well under free-tier limits - this takes a few
// minutes to run across ~200+ teams. That's fine; this is meant to run
// once per international window, not continuously.

const KEY = process.env.TSDB_KEY || '123';
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
// TheSportsDB's free tier is rate-limited to 30 requests/minute
// (https://www.thesportsdb.com/documentation#rate-limit) - 2100ms
// between requests keeps a safety margin under that (~28.5/min). A
// full run is ~200-250 teams plus ~15 to build the team list, so
// roughly 8-9 minutes end to end - fine for something run once per
// international window.
const DELAY_MS = 2100;

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

async function getJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
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
    console.error('Using the shared public test key - results will be incomplete. Set TSDB_KEY to your own free key for a full run.\n');
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
