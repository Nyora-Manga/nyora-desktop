# Nyora 0.2.3 — About link icons

The four About links now pair their existing labels with shared Nyora icons:
Website uses a globe, GitHub and Discord use their existing brand glyphs, and
License uses the book glyph. Each icon and label remain one link. Decorative
SVGs are hidden from assistive technology; link names, keyboard navigation and
destinations are unchanged. The shared button layout supplies sizing and spacing.
The About section allows 640 pixels for the four links on larger windows and
wraps them naturally on narrow windows.

This is a local rebuild of 0.2.3. The preceding four-link text-only build and its
receipts are preserved under `release/history/0.2.3-before-about-icons/`.

Validation on 2026-10-05 (Asia/Kolkata), native Mac ARM:

- All **299 desktop tests**, the full browser smoke and all copied-ASAR runtime
  gates passed. Existing link names, destinations, keyboard order and Settings
  navigation still pass the About browser checks.
- All **30 responsive layout checks passed** against the final 640px layout.
  Visual review confirms four icon-and-label links on one desktop row, two rows
  at 390px and three rows at 320px, without overflow or blocked controls.
  Screenshots are in `test-results/frontend-layout/about-{width}.png`.
- The ARM app, DMG and ZIP built successfully. The normal app reopened (PID
  21048) with the existing profile and private helper. Its served assets passed
  the normal-launch checks, and its captured overlay hash matches the visually
  checked frontend build.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | `aaa9926710cbadb4b4bff5f42d09eca1a1c7b7cdd9741e2c08ed54bd0738d5f6` |
| `Nyora-0.2.3-mac-arm64.zip` | `fd15c7f987b76276dbde7ca2362619c2b8a0e9515a35f8095bbd9b6306f41bf4` |

Current receipts in `release/`:
`runtime-validation-0.2.3-about-icons-darwin-arm64.json`,
`normal-launch-0.2.3-about-icons-darwin-arm64.json`,
`artifacts-0.2.3-about-icons-darwin-arm64.json`, and
`build-validation-0.2.3-about-icons-darwin-arm64.log`.
