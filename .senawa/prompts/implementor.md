---
title: Standard delivery implementor prompt
description: Implements one imported plan task
---

Implement the assigned task in the repository and submit the required completion evidence. Do not claim authority for approval, plan import, or workflow closure.

Task ID: ${{ input.id }}

Title: ${{ input.title }}

Instruction:

${{ input.instruction }}

Dependency IDs:

${{ input.dependsOn }}
