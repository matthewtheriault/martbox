# MartBox design

The canonical tokens are `design/tokens.json` (colours, the five accent presets, type, spacing, radius, sizes, shadows). Each app builds its styles from that file. The browsable version with live previews and a sample Home screen is the MartBox design system page.

MartBox is a home media server with apps for Mac, Windows, iPhone, Apple TV and (next) Fire TV and Android. Every screen is a dark room for posters: black ground, white type, and one accent gradient that the viewer chooses. These rules apply on every platform; TV sizes have their own type group and safe area.

## Colour

- Paint every page on `bg` (true black). Raise panels with `surface`; use `surface-hover` for the hovered or focused one. Never stack more than two surface levels.
- Set titles and body in `text`, metadata in `text-dim`, hints and placeholders in `text-dimmer`. All three pass 4.5:1 on `bg` and every surface.
- Borders are hairlines: `border` at 1px. Separate things with space before reaching for a border, and with a border before reaching for a shadow.
- `danger` is for errors and destructive actions, `success` for available or healthy. Both always come with a word or icon; colour alone never carries a state.

### The accent is the viewer's choice

The accent is a two-colour gradient at 135°, from `accent-start` to `accent-end`. Five presets ship, one per colour theme: **Blue** (the default), Purple, Pink, Orange and Green. Each person picks one in Settings → Appearance; it is saved per profile, so it follows them to every device.

- Build with the accent tokens only, never a preset's hex. A screen that works in Blue then works in every preset.
- The gradient fills at most one thing per view: the primary button, the selected chip, the progress fill, the brand mark. Everything else is neutral.
- Labels on the gradient are `accent-ink` (black), never white. Every preset was chosen so black passes 7.5:1 or more at both ends.
- For accent as text or a thin line (links, the live marker, the active tab's underline), use `accent-start` solid. It passes 7.7:1 or more on `bg` in every preset.
- Tint selected rows and the active sidebar link with `accent-wash` under `text`.
- `accent-glow` is the focus halo and the primary button's shadow (`shadow-primary`, `shadow-poster-focus`).
- No preset is red, so an accent is never confused with `danger`. Green shares a hue with `success`, which is why success always carries a word.

## Type

- One family everywhere: Inter (`sans`), shipped with each app rather than borrowed from the system, so Fire TV, Windows and Mac look the same. Apple apps may use SF Pro with the same sizes.
- Desktop and phone use the first group: `display` for hero titles only, `title-1` for page titles, `title-2` and `title-3` inside pages, `body` for reading, `body-sm` for metadata, `caption` under posters. `section` (row titles) and `overline` (eyebrows) are uppercase with their letter-spacing; `micro` is only for badges.
- TV uses the `tv-` group at 1920×1080. `tv-caption` (20px) is the smallest text on a TV; never use a desktop style there.
- The wordmark is “martbox”, lowercase, in `wordmark` (SF Rounded or the rounded stack).
- Text that sits on artwork (hero titles, the player banner) always sits on a scrim from `bg`, never on the bare image.

## Space, corners and size

- Space comes from the 4px scale: `space-1` (4) to `space-16` (64). Posters sit `space-4` apart; rows sit `space-10` apart; the desktop page gutter is `space-10`; phones keep at least `space-4`.
- TV screens keep everything focusable inside `tv-safe-x` (96px) and `tv-safe-y` (54px), with cards `tv-gap` (40px) apart so the focus scale never touches a neighbour.
- Corners: `radius-pill` for every button, chip and count; `radius-md` for posters, cards and rows; `radius-sm` for inputs and small boxes; `radius-lg` for dialogs and banners; `radius-xs` for progress bars.
- Posters are 2:3: `poster-w` × `poster-h` on desktop, `tv-poster-w` wide on TV. Touch targets are at least `tap-min` (44px).

## Focus, motion and states

- Pointer hover lifts a poster 6px and scales it to 1.035 with `shadow-poster-focus`.
- TV focus (Fire TV and Apple TV): the focused card scales to 1.06 with a 3px `focus-ring` outside it and `accent-glow` behind. Focus must be visible on every screen with no pointer.
- Motion is short and calm: 120–200ms ease-out, no bounces. Respect reduce-motion by dropping the scale and keeping the ring.
- Disabled controls drop to 40% opacity and keep their shape.

## Voice

Plain, friendly and short, like a friend who runs the server. Sentence case everywhere except `section` and `overline` labels. Say what happens: “Play”, “Resume from 12:40”, “Request”, “Stop stream”. Errors say what went wrong and what to do (“Can't reach the server. Check it's switched on, then try again.”). No emoji in the interface.

## Iconography

SF Symbols on Apple platforms and matching 1.75px-stroke line icons elsewhere (the desktop sidebar's set), at 18px beside `body-strong` labels and 16px inside inputs. Icons take the colour of the text beside them.

## Changes from the current apps

These tokens are the target style. Existing screens move to them in a later step; until then:

- the current accent is a purple-to-cyan gradient with white labels, which fails contrast at the cyan end (1.8:1). Blue with black labels replaces it.
- `bg` moves from #08080b to true black, and `text-dimmer` from #6b6a73 (3.2–3.9:1) to #8a8993.
- about 20 font sizes collapse to the 11 desktop styles above, and radii of 6, 7, 10 and 11px fold into `radius-sm` and `radius-md`.
