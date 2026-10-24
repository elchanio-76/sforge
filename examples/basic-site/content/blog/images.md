---
title: Responsive images
description: How staticforge turns one photo into a set of sizes and formats.
date: 2026-10-25
tags: [release, images]
---

This photo is a single 1600×900 JPEG next to this file. The build resizes it and offers AVIF and
WebP versions, so each browser downloads the smallest file that looks sharp on its screen:

![Gradient from deep blue to teal, standing in for a photo](harbour.jpg)

The `<img>` keeps its width and height, so the page does not jump while the image loads.
