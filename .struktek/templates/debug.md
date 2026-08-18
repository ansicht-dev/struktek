---
name: debug
description: Investigate a failure from a symptom
---
Something is wrong: {{ symptom: block "what you observe going wrong" }}

[It started after {{ trigger "a change, deploy, or upgrade" }}.]
[Reproduce with: {{ repro }}]

Find the root cause before proposing a fix. Tell me what you ruled out and why.
If you cannot reproduce it from what I have given you, say what you need.

Go {{ depth: depth = thorough }}
