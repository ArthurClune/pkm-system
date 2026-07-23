---
# pkm-7g64
title: bug in create links
status: todo
type: bug
priority: normal
created_at: 2026-07-23T19:45:42Z
updated_at: 2026-07-23T19:50:14Z
---


Bean pkm-965i created the link button, but one case is missed

Correct

testpage is here -> [[Testpage]] is here
and link [to a webpage] about stuff -> and link to a webpage about stuff #[[Testpage]]

Incorrect

a link test https://testpage.com/url more text -> a link test https://[[Testpage]].com/url more text
