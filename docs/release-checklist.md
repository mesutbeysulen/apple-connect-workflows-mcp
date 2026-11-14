# Release checklist

The path from a new app to a live version, in order. Each step names the command and the read tool that checks it. Steps marked **manual** have no App Store Connect API; `submission_manual_steps` lists them with Apple's links.

Replace `--account main --app APP_ID` with your values. Commands that preview need `--execute` to write.

## Once per app

1. **Manual:** sign the Apple Developer Program agreements and, in the EU, complete trader status.
2. Register the App ID: `bundle-id-create --identifier com.example.app --name "Example" --platform IOS`. Check with `bundle_ids_list`.
3. Turn on capabilities the app uses: `capability-enable --bundle BUNDLE_ID --capability PUSH_NOTIFICATIONS`.
4. **Manual:** create the app record in App Store Connect. The API cannot create apps.
5. Signing for your build machine: `certificate-create --type DISTRIBUTION --csr /path/request.certSigningRequest --out /path/cert.cer --execute`, then `profile-create --type IOS_APP_STORE --bundle BUNDLE_ID --certificates CERT_ID --out /path/app.mobileprovision`.

## App information

6. Content rights and primary language: `app-update --content-rights DOES_NOT_USE_THIRD_PARTY_CONTENT --primary-locale en-US`.
7. Name, subtitle and privacy policy per language: `app-info-set --locale en-US --name "Example" --privacy-url https://example.com/privacy`, or many languages at once with `metadata-sync`.
8. Categories: `app-category-set --primary ID` (IDs from `app_categories_list`).
9. Age rating: `age-rating-set --file /path/age-rating.json`.
10. **Manual:** App Privacy answers.
11. Optional: `eula-set`, `accessibility-set --publish-labels`.
12. Price and territories: `app-price-set --territory USA --price 0 --execute`, `availability-set --territories USA,TUR --execute`.

## The version

13. `version-create --platform IOS --version-string 1.0 --copyright "2026 Example"`. Check with `versions_list`.
14. Text per language: `metadata-sync --version VERSION_ID --file /path/metadata.json` (preview), then again with `--execute`.
15. Screenshots: `screenshots-sync --version VERSION_ID --dir /path/shots` (preview), then `--execute`. The folder layout is `<locale>/<placementGroup>/<files>`; get groups from `asset_ref_data` or `asset_placements_list`.
16. Optional media: `preview-upload` and `preview-place`; Header and Search Results with `creative-upload`, `creative-submit`, `creative-place`.
17. App Review contact: `review-detail-set --version VERSION_ID --first-name ... --email ...`; demo password from `APPLE_REVIEW_DEMO_PASSWORD`. Optional `review-attachment-upload`.
18. Routing apps only: `routing-coverage-upload`.

## The build

19. `build-upload --version 1.0 --build 1 --file /path/app.ipa`, then `build-wait --upload UPLOAD_ID`. Or build in Xcode Cloud with `ci-build-start` and `ci-build-wait`.
20. Export compliance: `build-compliance --build BUILD_ID --uses-encryption false`. If the build uses non-exempt encryption, `encryption-declaration-create`, `encryption-document-upload` and, after Apple approves it, `build-encryption-attach`.
21. Attach the build: `version-build-set --version VERSION_ID --build BUILD_ID`.

## TestFlight (optional before release)

22. `beta-info-set`, `beta-notes-set`, `beta-review-detail-set`.
23. `beta-group-create`, `beta-tester-add --emails ...`, `testflight-distribute --build BUILD_ID --group GROUP_ID`.
24. External testers: `beta-submit --build BUILD_ID`.

## In-app purchases and subscriptions (if any)

25. Create products: `iap-create`, `subscription-group-create`, `subscription-create`, plus `product-localize` or the version-based `product-version-*` commands.
26. Prices and where they are sold: `iap-price-set` or `subscription-price-set`, then `product-availability-set --all --execute`.
27. Review screenshot: `product-review-screenshot-upload`.
28. Include the product versions in step 31 with `--iap-version-ids` or `--subscription-version-ids`.

## Submit and release

29. `release-check --version VERSION_ID`. Fix each blocker; the `Fix:` hint names the command.
30. Confirm the manual checks: `--manual-checks app-privacy,screenshot-coverage,account-compliance,export-compliance,review-guidelines`.
31. `release-submit --version VERSION_ID --version-string 1.0 --manual-checks ...`. Check with `review_submissions_list`.
32. **Manual:** answer App Review messages in App Store Connect.
33. If the release type is manual: `release-publish --version VERSION_ID --version-string 1.0`. This cannot be undone. Optionally `phased-release --state ACTIVE` first.

## After release

34. Reviews: `customer_reviews_list`, `review-reply`.
35. Health: `perf_metrics`, `diagnostic_signatures_list`, `beta_feedback_list`.
36. Sales and analytics: `sales-download`, `finance-download`, `analytics-request`, `analytics-download`.
