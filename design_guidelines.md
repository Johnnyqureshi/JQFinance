# Design Guidelines: ORB Cyberpunk Trading Platform

## Design Approach
**Reference-Based: Elite Cyberpunk Trading Terminal**
Inspired by futuristic trading interfaces (Blade Runner UI, cyberpunk HUDs, institutional quant systems) with glassmorphism aesthetics. This is a utility-focused professional trading platform with premium visual treatment emphasizing data clarity through neon contrast and geometric precision.

## Color System
- **Backgrounds:** Deep black (#000000) and charcoal (#0a0a0f) foundations
- **Neon Accents:** Electric cyan (#00f0ff), magenta (#ff00ff), violet (#8b5cf6), neon green (#00ff88)
- **Glassmorphism:** Panels use backdrop-blur with 10-20% white/cyan transparency
- **Glow Effects:** box-shadow with color-matched blur (0 0 20px currentColor)
- **Grid Lines:** 1px borders in cyan/violet at 20% opacity

## Typography System
**Font Families via Google Fonts:**
- Headers: 'Orbitron' (weights: 700, 900)
- Body: 'Rajdhani' (weights: 400, 500, 600, 700)
- Data/Prices: 'IBM Plex Mono' (weights: 400, 600)

**Hierarchy:**
- Platform Title: text-4xl font-black (Orbitron) with neon glow effect
- Section Headers: text-2xl font-bold (Orbitron) uppercase tracking-wider
- Panel Headers: text-lg font-semibold (Rajdhani) uppercase tracking-wide
- Labels: text-sm font-medium (Rajdhani) uppercase
- Numerical Data: text-xl font-mono (IBM Plex Mono)
- Body Text: text-base font-normal (Rajdhana)
- Terminal Text: text-xs font-mono (IBM Plex Mono)

## Layout System
**Spacing Units:** Tailwind units of 3, 4, 6, and 8 for geometric precision

**Grid Structure:**
- Full-width dashboard with max-w-7xl container
- CSS Grid layout: 12-column system (grid-cols-12)
- Glassmorphic cards span 4-6 columns each
- Geometric dividers with 1px neon borders
- Terminal panel spans full width at bottom

## Core Components

### Platform Header
- Full-width with backdrop-blur glassmorphism
- Logo/title on left with neon glow text effect
- Real-time connection status badge on right (pulsing neon dot + "CONNECTED")
- Height: h-20 with px-8 horizontal padding
- Fixed position: sticky top-0 with z-50

### Trading Control Panel (Primary Glassmorphic Card)
- Glassmorphism treatment: backdrop-blur-xl with border-2 neon-outlined
- Rounded corners: rounded-2xl
- Padding: p-8
- Subtle glow on edges using box-shadow
- Spans 6 columns on desktop grid

### Bot Configuration Cards
- Multiple bot panels in grid layout (grid-cols-1 md:grid-cols-2 lg:grid-cols-3)
- Each card: glassmorphic panel with p-6 padding
- Header stripe with neon accent color per bot type
- Status indicator with animated glow pulse
- Sharp geometric borders with rounded-xl corners

### Asset Selector & Inputs
- Custom-styled dropdown with neon border on focus
- Height: h-14 for premium feel
- Glassmorphic background with backdrop-blur-md
- Neon-colored border (2px) that intensifies on hover/focus
- Placeholder text in cyan at 50% opacity

### Execute/Action Buttons
- Neon-outlined buttons with transparent fill
- Height: h-14 with px-8 padding
- Border: 2px solid with neon color
- Hover state: background glow with color at 20% opacity + intensified border glow
- Font: text-base font-bold uppercase tracking-wider (Rajdhani)
- Transition: transition-all duration-300

### Status Display Grid
- Grid of status cards below control panel
- Each card shows: bot name, status badge, key metrics
- Status badges: rounded-full with backdrop-blur, animated glow pulse
- Use Heroicons (outline) with neon stroke color
- Metrics displayed in monospace with large text-2xl sizing

### Terminal Log Panel
- Full-width panel at bottom (min-h-48)
- Background: pure black with subtle grid pattern
- Green monospace text (terminal aesthetic)
- Auto-scroll with smooth animation
- Shows: timestamps, trade executions, system events
- Each line: text-xs font-mono with opacity-80

### Trade Details Table
- Two-column layout within cards
- Labels: text-sm uppercase tracking-wide in cyan
- Values: text-lg font-mono with neon green color for gains, magenta for losses
- Row separators: 1px border in violet at 20% opacity
- Decimal alignment for numerical columns

### Geometric Grid Background
- Subtle grid pattern overlay on main background
- 32px grid spacing with 1px cyan lines at 10% opacity
- Applied to body element
- Creates institutional/technical aesthetic

## Icon Library
**Heroicons via CDN** - use outline variants exclusively with neon stroke colors

## Component Specifications

### Glassmorphism Panels
- backdrop-filter: blur(12px)
- background: linear-gradient with 15% white/cyan transparency
- border: 1-2px with neon accent color at 30% opacity
- Shadow: multi-layer glow (inner + outer box-shadow)

### Animated Elements
- Status indicators: infinite pulse animation (animate-pulse custom timing)
- Connection status: pulsing neon dot (scale + opacity animation)
- Button hovers: glow intensification (300ms ease-in-out)
- Data updates: brief flash animation on value change
- Terminal text: typing cursor blink animation

### Data Visualization
- Real-time price charts with neon line graphs
- Candlestick charts using cyan/magenta color scheme
- Grid lines in violet at low opacity
- Tooltip overlays with glassmorphic treatment

## Layout Structure

### Desktop (lg+)
- 12-column grid with gap-6
- Control panel: cols-span-6
- Bot cards: 2-3 columns each in grid
- Terminal: full-width at bottom (col-span-12)
- Sidebar potential: col-span-3 for watchlists

### Tablet/Mobile
- Single column stacking
- Cards span full width
- Reduced padding (p-4 instead of p-6)
- Collapsible terminal panel

## Accessibility
- High contrast neon text on dark backgrounds exceeds WCAG AAA
- All interactive elements have 3px neon focus rings
- Status communicated through icons + text, not color alone
- Screen reader announcements for real-time price updates
- Keyboard shortcuts for common trading actions (displayed in tooltips)

## Performance Considerations
- Backdrop-blur limited to 12px maximum for performance
- Animations use transform and opacity only (GPU-accelerated)
- Glow effects use box-shadow, not filters
- Terminal auto-scroll virtualized for performance with large logs

## Images
**No hero images** - this is a functional trading terminal focused on data density and real-time information. Visual impact comes from the cyberpunk UI treatment itself.