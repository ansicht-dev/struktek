---
name: code-review
description: Review a file for a specific class of problem
---
Review {{ target: file "path to the file under review" }} for {{ focus: choice[correctness, performance, security, readability] }}.

[Pay particular attention to {{ emphasis "anything specific to watch for" }}.]

{{ format: output-format = prose }}
