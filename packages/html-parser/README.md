# @autowp/html-parser

A dedicated HTML parsing package for extraction of metadata, links, assets, JSON-LD, and microdata.

## Features

- full HTML extraction from raw markup
- title, meta description, canonical URL
- internal / external link classification
- image, script, and stylesheet discovery
- JSON-LD extraction
- basic microdata extraction

## Usage

```ts
import { parseHtml } from '@autowp/html-parser';

const result = parseHtml(htmlString, 'https://example.com');
console.log(result.title);
```
