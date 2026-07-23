---
# pkm-zx19
title: file browser and attachment improvements
status: todo
type: feature
priority: normal
created_at: 2026-07-23T13:48:11Z
updated_at: 2026-07-23T13:54:14Z
---

We need a file browser for attachments. 

Basic:
* Search by date, file type
* Single select and multi-select
* Export to browser download
* UI for asset deletion, with loud warning if it's linked in db. Remove links when removing attachments
* UI to identify assets that are no longer linked in the db. Allow options of 1) delete or 2) copy link to the clipboard so user can add to a page

Advanced
* Update attachment ingestion such that an cheap model adds a searchable summary of images
* For PDFs, maybe try and store a quick description based on first page/first few pages?
* Make these summaries available to LLMs (via CLI/MCP?) to allow finding content
