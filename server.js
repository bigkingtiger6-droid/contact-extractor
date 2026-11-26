const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;
const PRIORITY_WORDS = ['contact', 'about', 'team', 'company', 'support', 'help', 'directory', 'location'];

const COUNTRY_RULES = [
  { regex: /\b(united states|u\.s\.a\.|usa)\b/i, country: 'United States', code: 'US' },
  { regex: /\b(united kingdom|u\.k\.|great britain|england|london)\b/i, country: 'United Kingdom', code: 'GB' },
  { regex: /\b(canada|toronto|vancouver)\b/i, country: 'Canada', code: 'CA' },
  { regex: /\b(australia|sydney|melbourne)\b/i, country: 'Australia', code: 'AU' },
  { regex: /\b(germany|deutschland|berlin|munich)\b/i, country: 'Germany', code: 'DE' },
  { regex: /\b(france|paris)\b/i, country: 'France', code: 'FR' },
  { regex: /\b(uae|united arab emirates|dubai|abu dhabi)\b/i, country: 'United Arab Emirates', code: 'AE' },
  { regex: /\b(saudi arabia|riyadh|jeddah)\b/i, country: 'Saudi Arabia', code: 'SA' },
  { regex: /\b(pakistan|lahore|karachi|islamabad)\b/i, country: 'Pakistan', code: 'PK' },
  { regex: /\b(india|mumbai|delhi|bangalore)\b/i, country: 'India', code: 'IN' },
  { regex: /\b(netherlands|amsterdam)\b/i, country: 'Netherlands', code: 'NL' },
  { regex: /\b(singapore)\b/i, country: 'Singapore', code: 'SG' }
];

function isSafeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.startsWith('192.168.') || h.startsWith('10.')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function detectCountry(text, pageUrl) {
  const sample = `${pageUrl} ${text.slice(0, 4000)}`;
  for (const rule of COUNTRY_RULES) {
    if (rule.regex.test(sample)) {
      return { country: rule.country, code: rule.code };
    }
  }
  return { country: 'Unknown', code: 'XX' };
}

function extractNames($) {
  const names = new Set();
  const roleWords = /(ceo|founder|director|manager|head|vp|president|owner|lead|representative|contact)/i;
  const namePattern = /^[A-Z][a-z]{1,18}\s+[A-Z][a-z]{1,22}$/;

  $('h1, h2, h3, h4, strong, b, li, p, div').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (txt.length > 3 && txt.length < 40 && namePattern.test(txt) && !roleWords.test(txt)) {
      const parentTxt = $(el).parent().text().replace(/\s+/g, ' ').trim();
      if (parentTxt.length < 220 && roleWords.test(parentTxt)) {
        names.add(txt);
      }
    }
  });

  return Array.from(names).slice(0, 30);
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebContactExtractor/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) return null;
    const text = await res.text();
    return text.slice(0, 1500000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/scan', async (req, res) => {
  try {
    let targetUrl = (req.body.url || '').trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    if (!isSafeUrl(targetUrl)) {
      return res.status(400).json({ error: 'براہِ کرم درست عوامی ویب سائٹ کا لنک دیں۔' });
    }

    const startParsed = new URL(targetUrl);
    const baseHost = startParsed.hostname.toLowerCase();
    const maxPages = 10;

    const visited = new Set();
    const queue = [targetUrl];
    const emailsMap = new Map();
    const namesSet = new Set();
    let siteCountry = { country: 'Unknown', code: 'XX' };

    while (queue.length > 0 && visited.size < maxPages) {
      const currentUrl = queue.shift();
      const cleanUrl = currentUrl.split('#')[0];
      if (visited.has(cleanUrl)) continue;
      visited.add(cleanUrl);

      const html = await fetchPage(cleanUrl);
      if (!html) continue;

      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ');

      const pageCountry = detectCountry(bodyText, cleanUrl);
      if (pageCountry.country !== 'Unknown' && siteCountry.country === 'Unknown') {
        siteCountry = pageCountry;
      }
      const finalCountry = pageCountry.country !== 'Unknown' ? pageCountry : siteCountry;

      $('a[href^="mailto:"]').each((_, el) => {
        const raw = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
        if (raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
          if (!emailsMap.has(raw)) {
            emailsMap.set(raw, {
              email: raw,
              country: finalCountry.country,
              code: finalCountry.code,
              source: cleanUrl
            });
          }
        }
      });

      const matches = bodyText.match(EMAIL_REGEX) || [];
      for (const m of matches) {
        const cleanEmail = m.toLowerCase().trim();
        if (!/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(cleanEmail) && !emailsMap.has(cleanEmail)) {
          emailsMap.set(cleanEmail, {
            email: cleanEmail,
            country: finalCountry.country,
            code: finalCountry.code,
            source: cleanUrl
          });
        }
      }

      for (const n of extractNames($)) {
        namesSet.add(n);
      }

      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href');
          if (!href) return;
          const resolved = new URL(href, cleanUrl);
          if (resolved.hostname.toLowerCase() === baseHost && /^https?:$/i.test(resolved.protocol)) {
            resolved.hash = '';
            const nextUrl = resolved.href;
            if (!visited.has(nextUrl) && !queue.includes(nextUrl) && queue.length < 30) {
              if (PRIORITY_WORDS.some((w) => nextUrl.toLowerCase().includes(w))) {
                queue.unshift(nextUrl);
              } else {
                queue.push(nextUrl);
              }
            }
          }
        } catch {}
      });
    }

    const emails = Array.from(emailsMap.values()).map((item) => ({
      ...item,
      country: item.country === 'Unknown' ? siteCountry.country : item.country,
      code: item.code === 'XX' ? siteCountry.code : item.code
    }));

    const groupedByCountry = {};
    for (const e of emails) {
      if (!groupedByCountry[e.country]) {
        groupedByCountry[e.country] = [];
      }
      groupedByCountry[e.country].push(e);
    }

    res.json({
      website: targetUrl,
      pagesScanned: visited.size,
      detectedCountry: siteCountry.country,
      emails,
      groupedByCountry,
      names: Array.from(namesSet)
    });
  } catch (err) {
    res.status(500).json({ error: 'ویب سائٹ اسکین کرنے میں مسئلہ آیا۔' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
        
