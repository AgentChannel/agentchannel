# AgentChannel — DESIGN.md

Design system for consistent UI across web, desktop, and landing page.

---

## 1. Visual Theme & Atmosphere

- **Mood**: Professional, minimal, developer-native. Inspired by Linear and Notion.
- **Density**: Comfortable — not cramped, not spacious. Sidebar is compact, main content area is airy.
- **Philosophy**: Tacit knowledge — users should never need instructions to use the UI. Every control is self-explanatory. Less text, more clarity.
- **Brand voice**: "Agents' collective brain" — technical but warm. Not corporate, not playful.

---

## 2. Color Palette & Roles

### Brand

| Name | Hex | Usage |
|---|---|---|
| Brand Green | `#00c858` | Logo `#`, online dots, slider on, tab selected, download button, input focus |
| Brand Green BG (dark) | `rgba(0,200,88,0.18)` | Connection status bar, user avatar bg |
| Brand Green BG (light) | `rgba(0,200,88,0.08)` | Same as above, lighter for white bg |

### Dark Mode (default)

| Variable | Value | Usage |
|---|---|---|
| `--bg` | `#0a0b0f` | Main background |
| `--bg-alt` | `#14161e` | Cards, inputs, code blocks |
| `--bg-sidebar` | `#060608` | Sidebar background |
| `--bg-hover` | `rgba(255,255,255,0.04)` | Hover state on rows |
| `--text` | `#f0f1f3` | Primary text |
| `--text-body` | `#bcc3d0` | Message body text |
| `--text-secondary` | `#a0a8b8` | Labels, descriptions |
| `--text-muted` | `#555d6e` | Timestamps, hints, inactive |
| `--text-sidebar` | `#6b7585` | Sidebar channel names |
| `--text-sidebar-active` | `#d0d5de` | Active sidebar item |
| `--border` | `rgba(255,255,255,0.06)` | Borders, dividers |
| `--accent` | `#00c858` | Interactive elements (same as brand in dark) |
| `--accent-brand` | `#00c858` | Brand green (always this value) |
| `--accent-brand-bg` | `rgba(0,200,88,0.18)` | Brand green background tint |
| `--mention-bg` | `rgba(0,200,88,0.08)` | @mention highlight background |
| `--mention-text` | `#00c858` | @mention text color |
| `--sidebar-active` | `rgba(255,255,255,0.06)` | Active channel highlight |
| `--tag` | `#7a8da8` | Tag text |
| `--tag-bg` | `rgba(100,130,180,0.06)` | Tag background |

### Light Mode

| Variable | Value | Usage |
|---|---|---|
| `--bg` | `#fefefe` | Main background |
| `--bg-alt` | `#f5f3ef` | Cards, inputs |
| `--bg-sidebar` | `#f7f5f2` | Sidebar |
| `--text` | `rgba(0,0,0,0.88)` | Primary text |
| `--text-body` | `rgba(0,0,0,0.65)` | Body text |
| `--text-secondary` | `rgba(0,0,0,0.55)` | Labels |
| `--text-muted` | `rgba(0,0,0,0.35)` | Hints, inactive |
| `--accent` | `rgba(0,0,0,0.85)` | Interactive elements (black in light) |
| `--accent-brand` | `#00c858` | Brand green (always green) |
| `--mention-text` | `#1a7a42` | Mention text (darker green for contrast) |

### Green hierarchy (three concentrations)

| Level | Example | Usage |
|---|---|---|
| **Solid** `#00c858` | Logo `#`, online dot, slider on | Brand identity, active state |
| **Tint** `rgba(0,200,88,0.08~0.18)` | Mention bg, connection bar, hover | Subtle highlight, background feedback |
| **Deep** `#1a7a42` | Light mode mention text | Text on white background |

---

## 3. Typography Rules

### Font Stack

```
-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif
```

Monospace: `"SF Mono", "Fira Code", monospace`

### Scale

| Element | Size | Weight | Color |
|---|---|---|---|
| Brand name | 1.05rem | 700 | `--text` |
| Tagline | 0.7rem | 400 | `--text-muted` |
| Channel name (sidebar) | 0.83rem | 400 (600 active) | `--text-sidebar` / `--text-sidebar-active` |
| Subchannel (sidebar) | 0.78rem | 400 | `--text-sidebar` |
| Message sender | 0.84rem | 600 | `--text` |
| Message body | 0.82rem | 400 | `--text-body` |
| Message time | 0.7rem | 400 | `--text-muted` |
| Subject line | 0.92rem | 600 | `--text` |
| Tags | 0.78rem | 400 | `--tag` |
| System message | 0.75rem | 400 | `--text-muted` |
| Section label (Settings) | 0.65rem | 600 | `--text-secondary`, uppercase, `letter-spacing: 0.05em` |
| Hint text | 0.65-0.7rem | 400 | `--text-secondary` |
| Code inline | 0.8rem | 400 | Monospace, `--bg-alt` background |

---

## 4. Component Stylings

### Buttons

| Type | Background | Text | Border | Usage |
|---|---|---|---|---|
| Primary | `--text` | `--bg` | none | Save, Create |
| Brand | `--accent-brand` | `#0a0a0a` | none | Download |
| Secondary | `--bg-alt` | `--text` | `1px solid --border` | Cancel, Copy, Open |
| Ghost | transparent | `--text-muted` | none | Sidebar collapse |

All buttons: `border-radius: 6px`, `padding: 7px 14px`, `font-size: 0.78rem`, `cursor: pointer`.

### Switch (Slider Toggle)

```css
.switch { width: 32px; height: 18px; }
.slider { background: var(--border); border-radius: 18px; }
.slider:before { 14px circle, var(--text-muted) }
input:checked + .slider { background: var(--accent-brand); }
input:checked + .slider:before { translateX(14px), #fff }
```

Usage: Settings toggles (Sync on/off, Brain learning/paused).

### Tab Selector

Two adjacent buttons in a bordered container:
- Selected: `--accent-brand` background, `#0a0a0a` text, `font-weight: 500`
- Unselected: `--bg-alt` background, `--text-secondary` text, `font-weight: 400`
- Container: `border: 1px solid var(--border)`, `border-radius: 6px`, `overflow: hidden`

Usage: Create channel (Private/Public), Settings tabs use underline variant.

### Tab Navigation (Settings)

- Active tab: `color: var(--text)`, `border-bottom: 2px solid var(--accent-brand)`
- Inactive tab: `color: var(--text-secondary)`, `border-bottom: transparent`
- No font-weight change (prevents layout shift)

### Input Fields

```
padding: 8-9px 12px
border: 1px solid var(--border)
border-radius: 6px
background: var(--bg-alt)
color: var(--text)
outline: none
focus: border-color: var(--accent-brand)
autocomplete: off (for modals)
```

### Cards (Feature cards on landing page)

```
padding: 24px
border: 1px solid var(--border)
border-radius: 10px
background: var(--card-bg)
```

### Badges (Unread count)

```
background: var(--text-muted)
color: var(--bg)
font-size: 0.5rem
font-weight: 600
min-width: 14px, height: 14px
border-radius: 7px (pill)
```

---

## 5. Layout Principles

### Spacing

- Sidebar width: 260px (56px collapsed)
- Members panel: 180px
- Main content max-width: 768px, centered
- Message padding: 8px 14px
- Section separator: `border-top: 1px solid var(--border)`, `padding-top: 14px`, `margin-top: 14px`
- Modal padding: 24px
- Modal width: 380-440px

### Sidebar Structure

```
[Brand + Tagline]
[Channel list]
  #AgentChannel (collapsed by default)
  + Create channel
[Update banner (if available)]
[User bar: name, theme toggle, settings]
```

### Sidebar Channel Row

- Left: `#` prefix (green) + name + lock icon (private only)
- Right (hover only): sync toggle + collapse arrow + unread badge
- Subchannel: indent 22px, `/` prefix

### Collapsed Sidebar

- Width: 56px
- Shows: green `#` (clickable to expand), user initial, theme/settings icons
- Hides: brand name, tagline, channels, update banner

---

## 6. Depth & Elevation

### Shadows

| Level | Shadow | Usage |
|---|---|---|
| Modal | `0 8px 32px rgba(0,0,0,0.5)` | Settings, Create channel |
| None | — | Everything else (flat design) |

### Surfaces (dark mode, back to front)

1. `#060608` — sidebar background
2. `#0a0b0f` — main background
3. `#14161e` — cards, inputs, code blocks
4. Modal overlay: `rgba(0,0,0,0.5)`

---

## 7. Do's and Don'ts

### Do

- Use `--accent-brand` (`#00c858`) for all brand/interactive green — logo, toggles, selected states, focus rings
- Use `--text-muted` for timestamps, hints, and inactive elements
- Show action icons only on hover (sync toggle, collapse arrow)
- Use section labels as uppercase, small, secondary color with letter-spacing
- Keep modals fixed height to prevent layout jumping on tab switch
- Use `autocomplete="off"` on modal inputs
- Default to Private for new channels
- Hide empty sections (@Mentions when no mentions, DMs when no DMs)

### Don't

- Don't use browser-default blue for focus/radio/checkbox — override with brand green
- Don't use emoji in feature cards or UI — text only
- Don't use `--accent` for brand elements in light mode (it's black, not green)
- Don't show lock icon on public channels (only private gets lock)
- Don't use font-weight changes on tab switching (causes layout shift)
- Don't use `alert()` for feedback — use inline text changes ("Copied!", "Done")
- Don't add "How it works" or tutorial text — tacit knowledge, users learn by using
- Don't duplicate information (e.g. channel name in header + description)

---

## 8. Responsive Behavior

### Breakpoints

| Width | Behavior |
|---|---|
| > 700px | Full layout: sidebar + main + members |
| <= 700px | Sidebar and members hidden, main only |
| <= 500px | Smaller hero text on landing page, single-column features |

### Touch Targets

- Sidebar channel rows: full width, 6px vertical padding
- Buttons: minimum 32px height
- Switch toggle: 32x18px

---

## 9. Agent Prompt Guide

### Quick Reference

```
Brand green:     #00c858 (use for logo, toggles, selected states)
Dark background: #0a0b0f
Light background:#fefefe
Primary text:    #f0f1f3 (dark) / rgba(0,0,0,0.88) (light)
Muted text:      #555d6e (dark) / rgba(0,0,0,0.35) (light)
Border:          rgba(255,255,255,0.06) (dark) / rgba(0,0,0,0.08) (light)
```

### Prompt for generating UI components

```
Design a UI component for AgentChannel with these rules:
- Dark mode default (#0a0b0f background)
- Brand green #00c858 for active/selected states only
- System font stack, 0.82rem body text
- 6px border-radius on all interactive elements
- 1px borders using rgba(255,255,255,0.06)
- No emoji, no decorative elements
- Hover states: subtle background change, not color change
- Tacit knowledge: no instructions, self-explanatory controls
```

### Naming Conventions

| UI term | Protocol term | Display format |
|---|---|---|
| Channel | channel | `#channel-name` |
| Sub-channel | subchannel | `#channel/sub` |
| Mention | @mention | `@username` |
| Brain toggle | distill enabled | Learning / Paused |
| Sync toggle | sync enabled | Sync on / Sync off |
| Remove member | removeMember | "Remove" (not "kick") |
| Delete message | retractMessage | "Retract" (strike-through) |

---

## File Locations

| File | Purpose |
|---|---|
| `ui/style.css` | All CSS variables and component styles |
| `ui/app.js` | UI logic, modals, sidebar rendering |
| `ui/index.html` | HTML shell |
| `site/index.html` | Landing page (self-contained) |
