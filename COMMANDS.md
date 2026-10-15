# Commands

Run from the project directory. Enable live publishing deliberately in `.env` after previewing.

| Task | Command |
| --- | --- |
| Product wizard | `npm run content:wizard` |
| Generate/resume preparation | `npm run content:setup` |
| Offline post preview | `npm run content:preview` |
| Publish continuously | `npm run content:start` |
| Publish and engage | `npm start` |
| Process one publication cycle | `node threads-agent.js start --once` |
| Saved metrics | `npm run content:status` |
| Refresh browser metrics | `npm run content:metrics` |
| Check platform logins | `node threads-agent.js auth all` |
| Inspect queue | `node threads-agent.js queue list` |
| Edit a draft | `node threads-agent.js queue edit ID --file FILE` |
| Reschedule | `node threads-agent.js queue reschedule ID --at ISO_TIME` |
| Repair writing | `node threads-agent.js queue rehumanize --pending` |
| Image preparation status | `node threads-agent.js images status` |
| Browser engagement preview | `npm run content:engage:preview` |
| Engage once | `npm run content:engage -- --once` |
| Approve reply | `node threads-agent.js content-engage --approve=ID` |
| Learned-source readiness | `npm run content:learn:status` |
| Synthesize saved examples | `npm run content:learn` |
| Research readiness | `node threads-agent.js research --status` |
| Run optional research | `node threads-agent.js research --resume` |
| Analyze account style | `node threads-agent.js analyze-style --x HANDLE --threads HANDLE` |
| Show settings | `node threads-agent.js settings show` |
| Validate settings | `node threads-agent.js settings validate` |
| Migrate older identity | `node threads-agent.js settings migrate` |
| Change cadence | `node threads-agent.js settings set strategy.post_frequency_hours 2` |
| Set checkout URL | `node threads-agent.js set-url https://your-sales-link.example/` |
| Inspect uncertain state | `node threads-agent.js recover --inspect` |
| Confirm published result | `node threads-agent.js recover --reconcile ID --published URL` |
| Requeue after confirming no publication | `node threads-agent.js recover --reconcile ID --requeue` |
| Configuration GUI | `node gui-server.js` |

Post preview is offline. Engagement preview reads the browser and calls AI but sends nothing. State-changing commands share the campaign lock. GUI saves require automation to be stopped. Preserve existing campaign/checkpoint files before replacing a campaign.
