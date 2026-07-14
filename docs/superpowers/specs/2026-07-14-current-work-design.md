# Current Work Page Design

## Goal

Add a "Current Work" page that helps users quickly find pages changed recently.

## Scope

The page is linked directly under "Daily Notes" in the left sidebar and is available at `/current-work`. It shows three exclusive sections:

1. Last 24 hours: pages with `updated_at >= now - 24h`
2. 24–48 hours: pages with `now - 48h <= updated_at < now - 24h`
3. 48 hours–7 days: pages with `now - 7d <= updated_at < now - 48h`

Pages older than 7 days or with no `updated_at` are omitted. Pages are sorted within each section by `updated_at DESC`, then title.

## Architecture

Add a read-only server endpoint, `GET /api/current-work`, returning grouped page metadata. Mirror that endpoint in the offline replica local API using the same grouping rules. Add a React view that fetches the endpoint, renders sections with page links, and refreshes on resync. Add a static left-nav link immediately below Daily Notes.

## Components

- Server response models define `CurrentWorkPage`, `CurrentWorkSection`, and `CurrentWorkPayload`.
- Server route computes bucket cutoffs from current time and queries `pages`.
- Replica local API computes the same payload from the local SQLite replica.
- `CurrentWork` React view renders loading, error, empty, and grouped states.
- `App` adds `/current-work` route and nav link.

## Error Handling

The API requires authentication like other read endpoints. The view shows a simple error message if loading fails. Empty sections render "No pages changed in this window." so users can distinguish an empty bucket from a failed load.

## Testing

- Server tests cover exclusive bucket boundaries, sorting, omission of null/old pages, and auth.
- Web local API tests cover bucket grouping.
- React tests cover rendering grouped links and empty sections.
- App tests cover the static left-nav link and route.
