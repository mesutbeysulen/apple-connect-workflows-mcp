/**
 * The single source for CLI help and the generated command reference in docs/commands.md.
 * Each command belongs to exactly one topic; test/help.test.ts keeps this in step with the CLI.
 */
export interface HelpTopic { id: string; title: string; summary: string; note?: string; commands: string }
export const USAGE = 'apple-connect-mcp <command> [options] [--config /absolute/config.json]';
export const NOTES = `Set APPLE_CONNECT_CONFIG instead of --config. No credentials are accepted as command arguments.
Review plan before apply. An interrupted apply may be retried with the same ID and digest
within its 30-minute expiry; remote state is reconciled before any further writes.
asset-cleanup only lists candidates unless --execute is given.
release-publish cannot be undone.`;
export const TOPICS: HelpTopic[] = [
  { id: 'core', title: 'Core', summary: 'Start the MCP server, check accounts, and run reviewed metadata plans.',
    commands: `  serve                         Start stdio MCP (default)
  doctor                        Check configured accounts against Apple
  smoke-read --account NAME [--app ID] [--out /absolute/report.json]  Run every read tool against Apple and report status, counts and field names (no writes)
  plan --plan ID                Print the exact saved plan and digest
  apply --plan ID --digest HASH  Execute this reviewed plan (requires writes enabled)` },
  { id: 'app-setup', title: 'App setup', summary: 'Bundle IDs, app information, categories, age rating, availability, versions, languages, review details and export compliance.', note: "the app record itself is created in App Store Connect",
    commands: `  bundle-id-create --account NAME --identifier com.example.app --name TEXT --platform IOS|MAC_OS|UNIVERSAL
  app-update --account NAME --app ID [--primary-locale tr] [--content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT|USES_THIRD_PARTY_CONTENT]
  app-info-set --account NAME --app ID --locale tr [--name TEXT] [--subtitle TEXT] [--privacy-url URL] [--privacy-choices-url URL] [--privacy-text TEXT]
  app-category-set --account NAME --app ID --primary ID [--primary-sub1 ID] [--primary-sub2 ID] [--secondary ID] [--secondary-sub1 ID] [--secondary-sub2 ID]
  age-rating-set --account NAME --app ID --file /absolute/age-rating.json
  availability-set --account NAME --app ID --territories USA,TUR [--new-territories] [--execute]
  version-create --account NAME --app ID --platform IOS --version-string 1.2.3 [--copyright TEXT] [--release-type MANUAL|AFTER_APPROVAL|SCHEDULED] [--release-date ISO]
  version-update --account NAME --app ID --version ID [--copyright TEXT] [--release-type TYPE] [--release-date ISO] [--version-string 1.2.3]
  version-build-set --account NAME --app ID --version ID --build ID
  build-compliance --account NAME --app ID --build ID --uses-encryption true|false
  encryption-declaration-create --account NAME --app ID --app-description TEXT --proprietary-crypto true|false --third-party-crypto true|false --french-store true|false
  encryption-document-upload --account NAME --app ID --declaration ID --file /absolute/document.pdf
  build-encryption-attach --account NAME --app ID --declaration ID --build ID
  version-localize --account NAME --app ID --version ID --locale tr [--description TEXT] [--keywords TEXT] [--whats-new TEXT] [--promotional-text TEXT] [--support-url URL] [--marketing-url URL]
  metadata-sync --account NAME --app ID --version ID --file /absolute/metadata.json [--execute]
  screenshots-sync --account NAME --app ID --version ID --dir /absolute/shots [--replace] [--execute]
  preview-upload --account NAME --app ID --file /absolute/preview.mp4 [--reference-name TEXT] [--preview-frame 00:00:02:00]
  preview-place --account NAME --app ID --version ID --localization ID --video ID --placement-group GROUP
  review-detail-set --account NAME --app ID --version ID [--first-name X] [--last-name X] [--phone X] [--email X] [--notes X] [--demo-required true|false] [--demo-name X]
                    (test password from APPLE_REVIEW_DEMO_PASSWORD)
  review-attachment-upload --account NAME --app ID --version ID --file /absolute/demo.mov
  review-cancel --account NAME --app ID --submission ID
  review-item-remove --account NAME --app ID --submission ID --item ID
  phased-release --account NAME --app ID --version ID --state INACTIVE|ACTIVE|PAUSED|COMPLETE` },
  { id: 'screenshots', title: 'Screenshots and previews', summary: 'Upload, order and clean up Asset Library screenshots and app previews.', note: "App Store Connect API 4.6+, recommended for new screenshots",
    commands: `  asset-upload --account NAME --app ID --version ID --localization ID --placement-group GROUP --file /absolute/image.png
               [--placement-type APP_SCREENSHOT|IMESSAGE_APP_SCREENSHOT] [--reference-name TEXT]
  asset-resume --account NAME --image ID
  asset-order --account NAME --app ID --version ID --localization ID --placement-group GROUP --order ID1,ID2,...
  asset-cleanup --account NAME --app ID [--older-than-hours 24] [--execute]` },
  { id: 'creative-assets', title: 'Header and Search Results', summary: 'Product page header and search results images or videos (iOS 27 / iPadOS 27 or later).', note: "creative assets, iOS 27 / iPadOS 27 or later",
    commands: `  creative-upload --account NAME --app ID --placements header,search --file /absolute/asset.png|.mov
                  [--reference-name TEXT] [--preview-frame 00:00:02:00]
  creative-resume --account NAME --asset ID
  creative-submit --account NAME --app ID [--images ID,...] [--videos ID,...]
  creative-place --account NAME --app ID --version ID --localization ID --placements header,search
                 (--image ID | --video ID) [--placement-group GROUP] [--replace]
  creative-remove --account NAME --app ID --version ID --localization ID --placement ID` },
  { id: 'legacy-screenshots', title: 'Legacy screenshot sets', summary: 'Apple\'s older appScreenshots API, deprecated but still served.', note: "appScreenshots; deprecated by Apple, still served",
    commands: `  screenshot-set-create --account NAME --app ID --version ID --localization ID --display-type APP_IPHONE_67
  screenshot-upload --account NAME --app ID --version ID --localization ID --set ID --file /absolute/image.png
  screenshot-resume --account NAME --screenshot ID
  screenshot-order --account NAME --app ID --version ID --localization ID --set ID --order ID1,ID2,...` },
  { id: 'builds', title: 'Builds', summary: 'Upload IPA or PKG files, resume or cancel uploads, wait for processing, distribute to TestFlight groups.',
    commands: `  build-upload --account NAME --app ID --version 1.2.3 --build 42 --file /absolute/app.ipa|.pkg [--platform IOS|MAC_OS|TV_OS|VISION_OS]
  build-resume --account NAME --upload ID
  build-cancel --account NAME --app ID --upload ID
  build-wait --account NAME --upload ID [--timeout-minutes 60] [--interval-seconds 30]
  testflight-distribute --account NAME --app ID --build ID --group ID1[,ID2,...]` },
  { id: 'testflight', title: 'TestFlight', summary: 'Beta information, what-to-test notes, Beta App Review, groups and testers.',
    commands: `  beta-info-set --account NAME --app ID --locale tr [--description TEXT] [--feedback-email X] [--marketing-url URL] [--privacy-url URL]
  beta-notes-set --account NAME --app ID --build ID --locale tr --whats-new TEXT
  beta-review-detail-set --account NAME --app ID [--first-name X] [--last-name X] [--phone X] [--email X] [--notes X] [--demo-required true|false] [--demo-name X]
  beta-submit --account NAME --app ID --build ID
  beta-group-create --account NAME --app ID --name TEXT [--public-link] [--feedback]
  beta-tester-add --account NAME --app ID --group ID --emails a@x.com,b@x.com
  beta-tester-remove --account NAME --app ID --group ID --tester ID` },
  { id: 'release', title: 'Release', summary: 'Readiness report, App Review submission and publishing.',
    commands: `  release-check --account NAME --app ID --version ID [--manual-checks ID1,ID2,...]
  release-submit --account NAME --app ID --version ID --version-string 1.2.3 --manual-checks ID1,ID2,...
                 [--iap-version-ids ID1,ID2,...] [--subscription-version-ids ID1,ID2,...] [--subscription-group-version-ids ID1,ID2,...]
  release-publish --account NAME --app ID --version ID --version-string 1.2.3` },
  { id: 'reviews', title: 'Customer reviews', summary: 'Reply to App Store reviews.',
    commands: `  review-reply --account NAME --app ID --review ID --text TEXT` },
  { id: 'commerce', title: 'In-app purchases and subscriptions', summary: 'Products, localizations, prices, sales territories, offers, offer codes, promoted purchases and sandbox testers.', note: "price commands preview unless --execute is given",
    commands: `  iap-create --account NAME --app ID --product-id ID --name TEXT --type CONSUMABLE|NON_CONSUMABLE|NON_RENEWING_SUBSCRIPTION
  subscription-group-create --account NAME --app ID --name TEXT
  subscription-create --account NAME --app ID --group ID --product-id ID --name TEXT --period ONE_MONTH [--group-level 1]
  product-localize --account NAME --app ID (--iap ID | --subscription ID) --locale tr --name TEXT [--description TEXT]
  product-version-create --account NAME --app ID --kind iap|subscription|subscription-group --product ID
  product-version-localize --account NAME --app ID --kind iap|subscription|subscription-group --product ID --version ID --locale en-US --name TEXT [--description TEXT] [--custom-app-name TEXT]
  product-version-image-upload --account NAME --app ID --kind iap|subscription --product ID --version ID --file /absolute/image.png
  intro-offer-set --account NAME --app ID --subscription ID --territory USA --offer-mode FREE_TRIAL|PAY_AS_YOU_GO|PAY_UP_FRONT
                  --duration ONE_WEEK --periods 1 [--price 0.99] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD] [--replace] [--execute]
  intro-offer-delete --account NAME --app ID --subscription ID --offer ID
  product-availability-set --account NAME --app ID --kind iap|subscription --product ID (--territories USA,TUR | --all) [--new-territories] [--execute]
  promo-offer-create --account NAME --app ID --subscription ID --name TEXT --offer-code ID --offer-mode MODE --duration ONE_MONTH --periods 1
                     [--prices USA=0.99,TUR=29.99] [--execute]
  promo-offer-delete --account NAME --app ID --subscription ID --offer ID
  offer-code-create --account NAME --app ID --kind iap|subscription --product ID --name TEXT --eligibility NEW,EXPIRED
                    [--offer-eligibility STACK_WITH_INTRO_OFFERS|REPLACE_INTRO_OFFERS --offer-mode MODE --duration D --periods N] [--prices USA=0.99] [--execute]
  offer-code-activate|offer-code-deactivate --account NAME --app ID --kind iap|subscription --product ID --offer-code ID
  offer-codes-generate --account NAME --app ID --kind iap|subscription --product ID --offer-code ID --count 100 --expires YYYY-MM-DD
                       [--environment PRODUCTION|SANDBOX] --out /absolute/codes.csv [--execute]
  offer-custom-code-create --account NAME --app ID --kind iap|subscription --product ID --offer-code ID --custom-code SPRING25 --count 1000 [--expires YYYY-MM-DD]
  promoted-purchase-set --account NAME --app ID --kind iap|subscription --product ID [--visible-all true|false] [--enabled true|false]
  promoted-purchase-delete --account NAME --app ID --promoted ID
  product-review-screenshot-upload --account NAME --app ID --kind iap|subscription --product ID --file /absolute/screenshot.png
  sandbox-tester-update --account NAME --tester ID [--territory USA] [--interrupt-purchases true|false] [--renewal-rate MONTHLY_RENEWAL_EVERY_FIVE_MINUTES]
  sandbox-history-clear --account NAME --testers ID1,ID2
  app-price-set --account NAME --app ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  iap-price-set --account NAME --app ID --iap ID --territory USA --price 4.99 [--start-date YYYY-MM-DD] [--execute]
  subscription-price-set --account NAME --app ID --subscription ID --territory USA --price 4.99
                         [--start-date YYYY-MM-DD] [--preserve-current-price] [--execute]` },
  { id: 'retention', title: 'Win-back and retention', summary: 'Win-back offers and retention messages for subscriptions.',
    commands: `  winback-create --account NAME --app ID --subscription ID --name TEXT --offer ID --offer-mode PAY_AS_YOU_GO|PAY_UP_FRONT --duration ONE_MONTH --periods 1
                 --paid-months 6 --lapsed-min 2 --lapsed-max 24 [--wait-months 2] --start-date YYYY-MM-DD [--end-date YYYY-MM-DD]
                 --priority HIGH|NORMAL [--promote true|false] --prices USA=4.99,TUR=99.99 [--execute]
  winback-update --account NAME --app ID --subscription ID --offer ID [--start-date D] [--end-date D] [--priority P] [--promote B] [--paid-months N] [--wait-months N]
  winback-delete --account NAME --app ID --subscription ID --offer ID
  retention-message-create --account NAME --app ID --name TEXT
  retention-localize --account NAME --app ID --message ID --locale tr [--header TEXT] [--body TEXT]
  retention-attach --account NAME --app ID --message ID --subscriptions ID1,ID2
  retention-submit --account NAME --app ID --message ID
  retention-delete --account NAME --app ID --message ID` },
  { id: 'marketing', title: 'Marketing', summary: 'Custom Product Pages, in-app events and product page A/B tests.', note: "Custom Product Pages, in-app events, product page A/B tests",
    commands: `  cpp-create --account NAME --app ID --name TEXT [--deep-link URL]
  cpp-update --account NAME --app ID --page ID [--name TEXT] [--visible true|false]
  cpp-delete --account NAME --app ID --page ID
  cpp-localize --account NAME --app ID --page-version ID --locale tr [--promotional-text TEXT]
  event-create --account NAME --app ID --name REFERENCE [--badge LIVE_EVENT] [--purpose ATTRACT_NEW_USERS] [--priority HIGH|NORMAL]
               [--primary-locale en-US] [--deep-link URL] [--purchase-requirement TEXT]
               [--territories USA,TUR --publish ISO --start ISO --end ISO]
  event-update --account NAME --app ID --event ID [same fields as event-create]
  event-delete --account NAME --app ID --event ID
  event-localize --account NAME --app ID --event ID --locale tr [--event-name TEXT] [--short-description TEXT] [--long-description TEXT]
  experiment-create --account NAME --app ID --name TEXT --platform IOS --traffic 30
  experiment-update --account NAME --app ID --experiment ID [--name TEXT] [--traffic 30] [--started true|false]
  treatment-create --account NAME --app ID --experiment ID --name TEXT [--icon-name NAME]
  treatment-localize --account NAME --app ID --treatment ID --locale tr
  marketing-place --account NAME --app ID --target cpp|experiment|event --localization ID (--image ID | --video ID)
                  --placement-type TYPE [--placement-group GROUP]
  marketing-order --account NAME --app ID --target cpp|experiment --localization ID --placement-group GROUP --order ID1,ID2,...
  marketing-submit --account NAME --app ID --kind cpp|experiment|event --id ID` },
  { id: 'listing-extras', title: 'Listing extras', summary: 'Custom license agreement, accessibility labels, routing coverage and Custom Product Page keywords.',
    commands: `  eula-set --account NAME --app ID --file /absolute/eula.txt (--territories USA,TUR | --all) [--execute]
  eula-remove --account NAME --app ID [--execute]
  accessibility-set --account NAME --app ID --device IPHONE|IPAD|APPLE_TV|APPLE_WATCH|MAC|VISION --supports voiceover,larger-text,... [--publish-labels]
  routing-coverage-upload --account NAME --app ID --version ID --file /absolute/coverage.geojson
  cpp-keywords-set --account NAME --app ID --localization ID --keywords word1,word2` },
  { id: 'app-clips', title: 'App Clips and background assets', summary: 'App Clip experiences and Apple-hosted background asset packs.',
    commands: `  appclip-default-set --account NAME --app ID --clip ID --action OPEN|VIEW|PLAY [--version ID]
  appclip-localize --account NAME --app ID --experience ID --locale tr --subtitle TEXT
  appclip-header-upload --account NAME --app ID --experience ID --locale tr --file /absolute/header.png
  appclip-review-urls --account NAME --app ID --experience ID --urls https://example.com/clip,...
  asset-pack-create --account NAME --app ID --identifier NAME
  asset-pack-upload --account NAME --app ID --asset-pack ID --file /absolute/pack.aar [--manifest /absolute/manifest.json] [--execute]
  asset-pack-submit --account NAME --app ID --asset-pack ID --pack-version ID` },
  { id: 'game-center', title: 'Game Center', summary: 'Leaderboards, sets, achievements, activities, challenges, groups and matchmaking on Apple\'s versioned model.', note: "Apple's versioned model: text and images belong to a version that goes through App Review",
    commands: `  gc-enable --account NAME --app ID [--version ID]
  gc-create --account NAME --app ID --kind leaderboard|achievement|leaderboard-set|activity|challenge --vendor-id ID --name REFERENCE [item fields]
  gc-update --account NAME --app ID --kind KIND --id ID [item fields] [--archived true|false]
    item fields: leaderboard --formatter INTEGER --sort DESC|ASC --submission BEST_SCORE|MOST_RECENT_SCORE [--range-start N --range-end N]
                             [--visibility SHOW_FOR_ALL|HIDE_FOR_ALL] [--recurrence-start ISO --recurrence-duration P7D --recurrence-rule FREQ=WEEKLY]
                 achievement --points 10 --show-before-earned true|false --repeatable true|false
                 activity [--play-style SYNCHRONOUS|ASYNCHRONOUS] [--min-players N --max-players N] [--party-code true|false] [--properties key=value,...]
                 challenge --leaderboard ID [--repeatable true|false]
  gc-version-create --account NAME --app ID --kind KIND --id ID
  gc-localize --account NAME --app ID --kind KIND --id ID --locale tr --title TEXT [--description TEXT] [--before TEXT --after TEXT]
              [--suffix TEXT --suffix-singular TEXT --formatter-override FORMAT]
  gc-image-upload --account NAME --app ID --kind KIND --id ID [--locale tr] --file /absolute/image.png
  gc-submit --account NAME --app ID --kind KIND --id ID [--app-version ID]
  gc-set-members --account NAME --app ID --set ID --leaderboards ID1,ID2
  gc-link-activity --account NAME --app ID --kind leaderboard|achievement --id ID --activity ID|none
  gc-default-leaderboard --account NAME --app ID --leaderboard ID
  gc-group-create --account NAME --name TEXT
  gc-group-join --account NAME --app ID --group ID [--execute]
  gc-match-ruleset-create --account NAME --name REF --min-players 2 --max-players 4 [--language-version 1]
  gc-match-rule-create --account NAME --ruleset ID --name REF --type COMPATIBLE|DISTANCE|MATCH|TEAM --expression EXPR --description TEXT [--weight N]
  gc-match-team-create --account NAME --ruleset ID --name REF --min-players 1 --max-players 2
  gc-match-queue-create --account NAME --ruleset ID --name REF [--bundle-ids com.example.a,com.example.b]` },
  { id: 'xcode-cloud', title: 'Xcode Cloud', summary: 'Start builds, wait for results, read failures and download artifacts.', note: "set up once in Xcode; these commands run and inspect builds",
    commands: `  ci-build-start --account NAME --app ID --workflow ID [--branch NAME | --tag NAME | --pull-request N | --rebuild BUILD_RUN_ID] [--clean] [--execute]
  ci-build-wait --account NAME --app ID --build-run ID [--timeout-minutes 90] [--interval-seconds 30]
  ci-build-report --account NAME --app ID --build-run ID
  ci-artifacts --account NAME --app ID --build-run ID
  ci-artifact-download --account NAME --app ID --build-run ID --artifact ID --out /absolute/file
  ci-workflow-enable|ci-workflow-disable --account NAME --app ID --workflow ID` },
  { id: 'reports', title: 'Reports', summary: 'Sales, finance and analytics reports merged into one file.',
    commands: `  sales-download --account NAME --vendor NUMBER --type SALES --subtype SUMMARY --frequency DAILY --from YYYY-MM-DD --to YYYY-MM-DD --out /absolute/sales.tsv [--report-version 1_0]
  finance-download --account NAME --vendor NUMBER --type FINANCIAL|FINANCE_DETAIL --region-code ZZ --from YYYY-MM --to YYYY-MM --out /absolute/finance.tsv
  analytics-request --account NAME --app ID [--access ONGOING|ONE_TIME_SNAPSHOT]
  analytics-download --account NAME --app ID --report-name NAME --granularity DAILY [--category COMMERCE] [--from YYYY-MM-DD] [--to YYYY-MM-DD] --out /absolute/analytics.tsv` },
  { id: 'team', title: 'Team members', summary: 'Invite people, change roles and app access, remove members.',
    commands: `  user-invite --account NAME --email X --first-name X --last-name X --roles DEVELOPER,APP_MANAGER (--all-apps | --apps ID,...) [--provisioning true|false] [--execute]
  user-update --account NAME --user ID [--roles A,B] [--all-apps | --apps ID,...] [--provisioning true|false] [--execute]
  user-remove --account NAME --user ID [--execute]
  invitation-cancel --account NAME --invitation ID` },
  { id: 'signing', title: 'Signing', summary: 'Devices, App ID capabilities, certificates and provisioning profiles.', note: "certificates, profiles, devices, App ID capabilities",
    commands: `  device-register --account NAME --name TEXT --udid UDID --platform IOS|MAC_OS
  device-update --account NAME --device ID [--name TEXT] [--status ENABLED|DISABLED]
  capability-enable|capability-disable --account NAME --bundle ID --capability PUSH_NOTIFICATIONS
  certificate-create --account NAME --type IOS_DISTRIBUTION --csr /absolute/request.certSigningRequest --out /absolute/cert.cer [--execute]
  certificate-revoke --account NAME --certificate ID [--execute]
  profile-create --account NAME --name TEXT --type IOS_APP_STORE --bundle ID --certificates ID1,ID2 [--devices ID1,ID2 | --all-devices] --out /absolute/x.mobileprovision
  profile-download --account NAME --profile ID --out /absolute/x.mobileprovision
  profile-delete --account NAME --profile ID` },
  { id: 'keys-webhooks', title: 'Keys, webhooks and audit', summary: 'API key setup, webhooks, the local webhook receiver and the write audit log.', note: "keys and webhooks",
    commands: `  key-setup --name NAME (--issuer UUID | --individual) --p8 /absolute/AuthKey_XXXXXXXXXX.p8 [--key-id ID] [--allow-app ID,...] [--replace]
  webhook-create --account NAME --app ID --name TEXT --url https://... --events A,B   (secret from APPLE_WEBHOOK_SECRET)
  webhook-enable|webhook-disable|webhook-ping|webhook-delete --account NAME --app ID --webhook ID
  webhook-redeliver --account NAME --app ID --webhook ID --delivery ID
  webhook-listen [--port 8787]   Local signed-event receiver, bound to 127.0.0.1
  audit [--limit 100]            Recent CLI writes on this database` },
  { id: 'eu-distribution', title: 'EU alternative distribution', summary: 'Alternative distribution keys, domains, marketplace search details and packages.',
    commands: `  alt-key-set --account NAME --app ID --public-key /absolute/key.pem
  alt-domain-add --account NAME --domain apps.example.com --name TEXT
  marketplace-search-set --account NAME --app ID --catalog-url https://...
  alt-package-create --account NAME --app ID --version ID` },
  { id: 'generic-writes', title: 'Any other write', summary: 'Reviewed, schema-checked plans for any catalog endpoint without a dedicated command.', note: "needs genericWrites: true; prepare plans with the api_write_plan MCP tool",
    commands: `  api-plan-show --plan ID
  api-apply --plan ID --digest HASH` },
];
/** Command names listed in a topic, taken from the first word of each command line. */
export function topicCommands(topic: HelpTopic): string[] {
  return [...new Set(topic.commands.split('\n').map(line => line.match(/^  ([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)/)?.[1]).filter((x): x is string => !!x).flatMap(name => name.split('|')))];
}
export function findTopic(name: string): HelpTopic | undefined {
  return TOPICS.find(t => t.id === name) ?? TOPICS.find(t => topicCommands(t).includes(name));
}
/** Short overview: usage, then one line per topic. */
export function overview(): string {
  const width = Math.max(...TOPICS.map(t => t.id.length));
  return [USAGE, '', 'Topics (run: apple-connect-mcp help <topic> or <command> --help):', ...TOPICS.map(t => `  ${t.id.padEnd(width)}  ${t.summary}`),
    '', '  all' + ' '.repeat(Math.max(1, width - 1)) + 'Every command', '', NOTES].join('\n');
}
export function topicHelp(topic: HelpTopic): string {
  return [`${topic.title}: ${topic.summary}`, ...(topic.note ? [`(${topic.note})`] : []), '', topic.commands, '', NOTES].join('\n');
}
export function allHelp(): string {
  return [USAGE, '', ...TOPICS.flatMap(t => [` ${t.title}${t.note ? ` (${t.note})` : ''}`, t.commands, '']), NOTES].join('\n');
}
