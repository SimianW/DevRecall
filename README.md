# DevRecall

DevRecall is a Chrome extension that helps you save useful technical pages and find them again when you need them.

## What you can do

- Save documentation, GitHub pages, Stack Overflow answers, articles, and other technical references.
- Search your saved pages by keyword.
- Use optional AI features for summaries, topics, technologies, and meaning-based search.
- Turn on auto-save for common developer sites.
- Filter your library by site and content type.
- Export your library or delete it at any time.

## How it works

Open DevRecall from the Chrome toolbar. Save the page you are viewing, then use the side panel to search or browse your library.

Every page is saved locally first, so saving and keyword search work without an API key. If you want AI summaries or meaning-based search, add your own OpenAI API key in DevRecall's settings.

## Choose how DevRecall uses AI

**Local-only** keeps automatic saving and search on your device. DevRecall contacts OpenAI only when you choose an AI action for a saved page.

**Hybrid** adds AI summaries and meaning-based search when an OpenAI API key is available. Page content and search queries may be sent to OpenAI while you use these features.

If an AI request fails, your locally saved page and keyword search still work.

## Your data

DevRecall stores your library and API key in your browser profile. It does not have a separate account or sync service.

You stay in control of when AI features are used, and you can export or delete your saved data from the settings page.
