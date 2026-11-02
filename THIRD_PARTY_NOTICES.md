# Third-party notices

## FreeLLMAPI

Parts of Hoppy's built-in model catalog (`media/catalog.json`: provider list, model ids, free-tier limits,
intelligence and speed ranks) were seeded from data in FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi).
Only data was copied, no code. Hoppy does not contact FreeLLMAPI or its catalog service.

MIT License

Copyright (c) 2026 Tashfeen Ahmed

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

## Claude Code Usage (GrowthJack)

Hoppy's read of the 5-hour and weekly usage % (`src/quota.ts`) follows the request shown in Claude Code Usage
by GrowthJack (MIT License, Copyright (c) 2025 GrowthJack): the endpoint and headers only. Hoppy's code is its own,
and unlike that extension it never refreshes or writes the login token.
