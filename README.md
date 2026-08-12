# Unscheduled Call Complete - GHL

Automates verifying unscheduled call completion in GoHighLevel. Searches for a lead, finds "Call completed" message in conversation, extracts duration, and screenshots if call meets 5-minute threshold.

## Actor IDs

- **Actor ID:** `EAEATOookeiuIM2Zf`
- **Platform:** Apify Cloud

## Setup

```bash
cd unscheduled-call-complete-actor
npm install
```

## Refresh Cookies (do this every few days)

```bash
# Set INPUT.json to login mode
echo '{"loginMode": true, "subAccountUrl": "https://app.tjbdigitalservices.com/v2/location/ANY_LOCATION_ID/dashboard", "leadName": "test"}' > storage/key_value_stores/default/INPUT.json

# Run - browser opens, log in, reach any dashboard page
npx tsx src/main.ts

# Cookies saved to storage-state.json
# Copy to appointment-booking-actor too:
cp storage-state.json ../appointment-booking-actor/storage-state.json
```

After login, the script auto-saves once you reach `/dashboard`, `/agency_dashboard`, or `/v2/location/*`.

## Run Locally

```bash
# Set input
echo '{"subAccountUrl": "https://app.tjbdigitalservices.com/v2/location/LOCATION_ID/dashboard", "leadName": "Lead Name"}' > storage/key_value_stores/default/INPUT.json

npx tsx src/main.ts
```

## Run on Cloud (API call)

```json
{
  "subAccountUrl": "https://app.tjbdigitalservices.com/v2/location/LOCATION_ID/dashboard",
  "leadName": "Lead Name",
  "storageState": { /* contents of storage-state.json */ }
}
```

Cloud requires `storageState` field with full cookie JSON.

## Deploy

```bash
APIFY_TOKEN=your_token apify push --force
apify builds add-tag -b BUILD_ID -t latest
```

## Input

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| subAccountUrl | string | yes | GHL sub-account dashboard URL |
| leadName | string | yes | Lead name to search |
| storageState | object | cloud only | Browser session JSON |
| loginMode | boolean | no | Opens browser for manual login |
| screenshotOnly | boolean | no | Skip call search, just screenshot conversation |

## Output

```json
{
  "leadFound": true,
  "leadName": "Lead Name",
  "callFound": true,
  "duration": "5:23",
  "durationSeconds": 323,
  "meetsThreshold": true,
  "screenshotUrl": "https://api.apify.com/v2/key-value-stores/STORE_ID/records/call-screenshot",
  "error": null
}
```

## Config

- **RAM:** 2048MB
- **Timeout:** 3600s
- **Duration threshold:** 5 minutes (300s)
