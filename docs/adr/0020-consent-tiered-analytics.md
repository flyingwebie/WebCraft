# Analytics counts anonymous totals without consent and visitors only with it

WebCraft is used worldwide, so no single consent rule fits every Site. Each Site sets its Consent banner to Opt-in (the default), Opt-out or No banner. Before a visitor accepts, or after they decline, tracking stays cookieless and counts only anonymous totals (page views, source, country, device) with no visitor hash, so nothing links one page view to another. Only after the Analytics category is accepted does it count unique visitors, visits, Goals and Funnels, using a hash with a daily salt. The visitor's IP address is used only to work out the country and is never stored. Totals stay roughly right even when many visitors decline, and Staff, who know where each client operates, decide how strict a Site is.

## Considered Options

- **Count nothing until consent**: simplest legally, but on opt-in Sites it hides most traffic and makes client reports misleading.
- **Count everything, and let the banner only control third-party scripts**: not lawful where opt-in rules apply.
