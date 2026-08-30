import dns from "node:dns/promises";
import net from "node:net";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 7000;

function trimUrlPunctuation(value) {
  return value.replace(/[),.;!?。、，．！？）】」』]+$/u, "");
}

export function extractHttpUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'「」『』【】。、，．！？]+/giu) || [];
  return [...new Set(matches.map(trimUrlPunctuation))].filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function absoluteHttpUrl(value, baseUrl) {
  if (!value) return "";
  try {
    const resolved = new URL(value, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : "";
  } catch {
    return "";
  }
}

export function extractPageMetadata(html, baseUrl) {
  const metas = [...String(html || "").matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const findMeta = (...keys) => {
    for (const tag of metas) {
      const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
      if (keys.includes(key)) return attr(tag, "content");
    }
    return "";
  };
  const titleTag = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const title = (findMeta("og:title", "twitter:title") || decodeHtml(titleTag).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  let image = findMeta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src");
  if (!image) {
    const imageLink = [...String(html || "").matchAll(/<link\b[^>]*>/gi)]
      .map((match) => match[0])
      .find((tag) => attr(tag, "rel").toLowerCase() === "image_src");
    image = imageLink ? attr(imageLink, "href") : "";
  }
  return { title, imageUrl: absoluteHttpUrl(image, baseUrl) };
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice(7);
      if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
    }
    return value === "::1" || value === "::" || value.startsWith("fc") ||
      value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") ||
      value.startsWith("fea") || value.startsWith("feb");
  }
  return true;
}

async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("外部HTTP URLではありません");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("ローカルURLは取得できません");
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("プライベートIPは取得できません");
  } else {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("公開IPへ解決できません");
    }
  }
  return url;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("取得サイズが上限を超えています");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("取得サイズが上限を超えています");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchPublic(value, maxBytes, accept) {
  let current = value;
  for (let redirect = 0; redirect <= 4; redirect++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: accept, "User-Agent": "TomifufuCouponBot/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("転送先がありません");
      await response.body?.cancel();
      current = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`URL取得に失敗しました (${response.status})`);
    return {
      buffer: await readLimited(response, maxBytes),
      contentType: (response.headers.get("content-type") || "").toLowerCase(),
      finalUrl: url.href,
    };
  }
  throw new Error("転送回数が上限を超えています");
}

export async function fetchUrlPreview(value) {
  const page = await fetchPublic(value, MAX_HTML_BYTES, "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.1");
  if (page.contentType.startsWith("image/")) {
    return { title: "", image: page.buffer, finalUrl: page.finalUrl };
  }
  if (!page.contentType.includes("text/html") && !page.contentType.includes("application/xhtml+xml")) {
    return { title: "", image: null, finalUrl: page.finalUrl };
  }
  const metadata = extractPageMetadata(page.buffer.toString("utf8"), page.finalUrl);
  if (!metadata.imageUrl) return { title: metadata.title, image: null, finalUrl: page.finalUrl };
  try {
    const image = await fetchPublic(metadata.imageUrl, MAX_IMAGE_BYTES, "image/*");
    if (!image.contentType.startsWith("image/")) {
      return { title: metadata.title, image: null, finalUrl: page.finalUrl };
    }
    return { title: metadata.title, image: image.buffer, finalUrl: page.finalUrl };
  } catch {
    return { title: metadata.title, image: null, finalUrl: page.finalUrl };
  }
}
