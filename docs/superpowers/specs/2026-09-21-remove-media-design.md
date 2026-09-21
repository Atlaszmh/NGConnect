# Remove Show / Movie — Design

**Date:** 2026-09-21
**Status:** Approved by user

## Problem

NGConnect can add shows and movies to Sonarr/Radarr but cannot remove them.
Cleaning up means opening the arr's own UI.

## Goal

A "Remove" action on each movie card (Movies page) and series row (TV page)
that deletes the library entry AND its files on disk from the arr. Re-adding
the same title later must work through the existing flows (Add button on the
page, or a Search-page grab which auto-adds) with no extra steps.

## Approach

Client-only. The existing catch-all proxies (`/api/radarr/*path`,
`/api/sonarr/*path`) already forward DELETE with query strings, so the pages
call the arr delete endpoints directly:

- `DELETE /radarr/movie/{id}?deleteFiles=true`
- `DELETE /sonarr/series/{id}?deleteFiles=true`

Never send `addImportExclusion` / `addImportListExclusion`. Both arrs purge the
title's history on delete (verified in `HistoryService.Handle(*DeletedEvent)`),
so a later grab is not blocked by "recent grab meets cutoff", and
`ensureMovie`/`ensureSeries` do a fresh lookup + POST which succeeds again once
the entry is gone.

## UI

- Movies: "Remove" button next to "Search" in the poster overlay.
- TV: "Remove" button next to "Search Missing" in the series row (whole show).
- Native `window.confirm` naming the title and stating files will be deleted.
- While in flight the button reads "Removing...". On success the card is
  dropped from local state (no refetch). On failure the card stays and a
  native alert shows the error.

## Out of scope

Plex library refresh after removal (the arrs' own Plex Connect handles it if
configured), a styled confirm modal, per-season removal.
