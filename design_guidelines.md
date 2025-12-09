# Design Guidelines: ORB Trading Dashboard

## Design Approach
**Reference-Based: Modern Financial Dashboard**
Drawing inspiration from professional trading platforms (Robinhood, Interactive Brokers) with Material Design principles for clarity and efficiency. This is a utility-focused application where real-time data visibility and quick configuration are paramount.

## Typography System
**Font Family:** 
- Primary: 'Inter' or 'SF Pro Display' via Google Fonts
- Monospace: 'IBM Plex Mono' for numerical data

**Hierarchy:**
- Dashboard Title: text-3xl font-bold
- Section Headers: text-lg font-semibold
- Labels: text-sm font-medium uppercase tracking-wide
- Data/Status: text-base font-normal
- Numerical Values: font-mono text-lg for prices/percentages
- Helper Text: text-xs

## Layout System
**Spacing Units:** Tailwind units of 2, 4, 6, and 8 (p-4, gap-6, mb-8, etc.)

**Grid Structure:**
- Single-column centered container: max-w-2xl mx-auto
- Dashboard cards with p-6 padding
- Form elements with gap-4 spacing
- Status displays with p-4 internal spacing

## Core Components

### Dashboard Container
- Centered layout with max-w-2xl
- Vertical stack with gap-8 between major sections
- Top padding: pt-12, bottom: pb-16

### Trading Control Panel (Primary Card)
- Prominent card with rounded-xl borders
- Shadow: shadow-lg for elevation
- Internal padding: p-6
- Contains dropdown and input in two-column grid (grid-cols-2 gap-4 on desktop, stacks on mobile)

### Asset Selector
- Full-width dropdown with rounded-lg corners
- Height: h-12 for comfortable touch targets
- Font: text-base with placeholder text
- Padding: px-4

### Take Profit Input
- Number input with percentage symbol inline
- Same styling as dropdown for consistency
- Validation indicators (built into input state)

### Execute Button
- Full-width primary action button
- Height: h-12
- Rounded: rounded-lg
- Font: text-base font-semibold
- Positioned below inputs with mt-6 spacing

### Status Display Card
- Separate card below control panel
- Rounded-xl with shadow-md
- Padding: p-6
- Contains status indicator and detailed trade information

### Status Indicators
- Large status badge with rounded-full pills
- Status text: font-semibold text-sm uppercase tracking-wide
- Different visual treatments per state (WAIT, NO_BREAKOUT, TRADE_PLACED, ERROR)
- Icon integration using Heroicons (clock, chart, check, alert)

### Trade Details Table
- When trade is placed, show structured data
- Two-column layout (label: value)
- Labels: text-sm font-medium
- Values: text-base font-mono for numbers
- Row spacing: space-y-3

### Header Section
- Application title: text-3xl font-bold
- Subtitle/description: text-base mt-2
- Container: mb-8

## Icon Library
**Heroicons via CDN** - use outline variants for UI chrome, solid for status indicators

## Component Specifications

**Navigation/Header:**
- Simple centered header with app branding
- No complex navigation needed (single-page app)
- API status indicator (connected/disconnected) in top-right corner as small badge

**Forms:**
- Consistent input heights (h-12)
- Clear focus states with border treatment
- Label positioning: above inputs with mb-2
- Error messages: text-sm mt-1

**Data Display:**
- Numerical data always in monospace font
- Align decimal points in tables
- Clear visual separation between data rows (border-b last:border-0)

**Overlays:**
- Loading states: centered spinner with backdrop blur
- Inline loading for button states (spinner replaces text)

## Animations
**Minimal and Purposeful:**
- Smooth transitions on status changes (transition-all duration-300)
- Button hover states with scale or opacity changes
- NO complex scroll animations or decorative effects
- Focus on instant feedback and responsiveness

## Images
**No hero images required** - this is a functional dashboard, not a marketing page. Focus on clarity and data presentation.

## Accessibility
- All form inputs with proper labels and aria-attributes
- Status messages with role="status" for screen readers
- Color-independent status indicators (always include icons/text)
- Keyboard navigation for all interactive elements
- Focus visible states on all controls

## Layout Constraints
- Single viewport approach - entire dashboard visible without scrolling on desktop
- Responsive breakpoint at md: for mobile adaptation
- Mobile: stack all elements vertically with full-width components
- Desktop: maintain compact, focused layout