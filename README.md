# Kendamil Qatar – Meta Ads connector for Claude (read-only)

A tiny server that lets Claude read the Kendamil Qatar ad results from Meta. It can only READ. It cannot create, edit, pause or spend anything. No packages to install.

Tools Claude gets:
- get_account_overview: account name, currency and totals for a period
- get_ad_performance: spend, impressions, reach, clicks, link clicks, CTR, CPC, CPM, add to cart, purchases, purchase value and ROAS, per ad / ad set / campaign, by day or by age, gender, platform, placement, region or device; filter by name (e.g. "KQ-016")
- list_ads: every ad with its status, headline, primary text and image

## 1. Make the Meta token (Meta Business Settings)
1. business.facebook.com → Business Settings → Users → System users → Add (name: claude-reader, role: Employee).
2. Click it → Assign assets → Ad accounts → Kendamil Qatar → turn on only "View performance".
3. Generate new token → choose your Meta app → tick ONLY `ads_read` → Generate. Copy it (it is shown once).
4. Note the ad account ID (Ads Manager URL shows `act=1234567890`).

## 2. Put the code on GitHub
1. github.com/new → name `kendamil-meta-ads-mcp` → Private → Create repository.
2. On the empty repo page click "uploading an existing file", drag in the CONTENTS of this folder (`api` folder, `package.json`, `README.md`), then Commit changes.
   (The file must end up at `api/mcp/[key].js`, brackets included.)

## 3. Deploy on Vercel
1. vercel.com → Add New → Project → Import `kendamil-meta-ads-mcp`. Framework preset: Other. No build settings needed.
2. Before clicking Deploy, open Environment Variables and add:
   - `META_ACCESS_TOKEN` = the token from step 1
   - `META_AD_ACCOUNT_ID` = act_1234567890 (your account ID)
   - `MCP_PATH_KEY` = a long random secret, e.g. from https://www.uuidgenerator.net (use 2 joined together). Anyone with the full URL can read ad results, so keep it private.
   - (optional) `META_API_VERSION` = v23.0 (or the current Graph API version)
3. Deploy. Your connector URL is:
   `https://<your-project>.vercel.app/api/mcp/<MCP_PATH_KEY>`

## 4. Add it to Claude
claude.ai → Settings → Connectors → Add custom connector → Name: "Kendamil Meta Ads" → URL: the URL above → Add. (On a Team plan an organization owner may need to do this.) Leave OAuth fields empty.

Then tell Claude "connector added". Claude will test it and add it to the daily Kendamil scheduled task.

## Notes
- If you rotate the token, update `META_ACCESS_TOKEN` in Vercel and redeploy.
- To revoke access at any time: delete the system user token in Meta, or delete the Vercel project.
- Name every Meta ad with its KQ ID first, e.g. `KQ-016 · EN · Range · Proof`, so results match the creative plan.
