import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SOURCE_URL_LENGTH = 500;
const MAX_LABEL_LENGTH = 80;
const MAX_NOTES_LENGTH = 500;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|m4v|mov|webm|avi|mkv)$/i;

type OEmbedPayload = {
  title?: unknown;
  author_name?: unknown;
  provider_name?: unknown;
  thumbnail_url?: unknown;
  duration?: unknown;
};

type DirectVideoMetadata = {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
};

function sanitizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function sanitizeSourceUrl(value: unknown) {
  const text = sanitizeText(value, MAX_SOURCE_URL_LENGTH);
  if (!text) return { error: "Source URL is required." };

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "Source URL must use http or https." };
    }

    return { value: url };
  } catch {
    return { error: "Source URL is not valid." };
  }
}

function getHost(url: URL) {
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

function getYoutubeVideoId(url: URL) {
  const host = getHost(url);

  if (host === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/").filter(Boolean)[1] ?? null;
    }
  }

  return null;
}

function getPlatform(url: URL) {
  const host = getHost(url);

  if (getYoutubeVideoId(url)) return "YouTube";
  if (host === "vimeo.com" || host === "player.vimeo.com") return "Vimeo";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "TikTok";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "Instagram";
  if (host === "x.com" || host === "twitter.com") return "X";
  if (VIDEO_EXTENSION_PATTERN.test(url.pathname)) return "Direct video";

  return host || "Web video";
}

function getOEmbedEndpoint(url: URL) {
  const host = getHost(url);
  const sourceUrl = encodeURIComponent(url.toString());

  if (getYoutubeVideoId(url)) {
    return `https://www.youtube.com/oembed?url=${sourceUrl}&format=json`;
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    return `https://vimeo.com/api/oembed.json?url=${sourceUrl}`;
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return `https://www.tiktok.com/oembed?url=${sourceUrl}`;
  }

  return null;
}

function getEmbedUrl(url: URL) {
  const youtubeId = getYoutubeVideoId(url);
  if (youtubeId) return `https://www.youtube.com/embed/${youtubeId}`;

  const host = getHost(url);
  if (host === "player.vimeo.com") return url.toString();

  const vimeoMatch = url.pathname.match(/^\/(\d+)/);
  if ((host === "vimeo.com" || host === "player.vimeo.com") && vimeoMatch?.[1]) {
    return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  }

  return null;
}

function getFallbackThumbnailUrl(url: URL) {
  const youtubeId = getYoutubeVideoId(url);
  return youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null;
}

function getFileNameFromUrl(url: URL) {
  const rawName = url.pathname.split("/").filter(Boolean).at(-1);
  if (!rawName) return null;

  try {
    return decodeURIComponent(rawName).slice(0, 140);
  } catch {
    return rawName.slice(0, 140);
  }
}

function isPrivateHost(url: URL) {
  const host = url.hostname.toLowerCase();

  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = 4500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOEmbed(url: URL, warnings: string[]) {
  const endpoint = getOEmbedEndpoint(url);
  if (!endpoint) return null;

  try {
    const response = await fetchWithTimeout(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      warnings.push("공개 메타데이터를 가져오지 못해 URL 기반 초안으로 분석했습니다.");
      return null;
    }

    const payload = (await response.json()) as OEmbedPayload;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    warnings.push("외부 메타데이터 요청 시간이 초과되어 URL 기반 초안으로 분석했습니다.");
    return null;
  }
}

async function fetchDirectVideoMetadata(url: URL, warnings: string[]): Promise<DirectVideoMetadata> {
  if (!VIDEO_EXTENSION_PATTERN.test(url.pathname)) {
    return { filename: null, mimeType: null, sizeBytes: null };
  }

  const filename = getFileNameFromUrl(url);

  if (isPrivateHost(url)) {
    return { filename, mimeType: null, sizeBytes: null };
  }

  try {
    const response = await fetchWithTimeout(url.toString(), {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
    });

    if (!response.ok) {
      warnings.push("영상 파일 헤더를 확인하지 못했습니다. 파일 정보는 저장 전에 직접 확인해 주세요.");
      return { filename, mimeType: null, sizeBytes: null };
    }

    const contentType = response.headers.get("content-type");
    const contentLength = Number(response.headers.get("content-length"));

    return {
      filename,
      mimeType: contentType?.slice(0, 80) ?? null,
      sizeBytes: Number.isFinite(contentLength) ? Math.round(contentLength) : null,
    };
  } catch {
    warnings.push("영상 파일 헤더 요청 시간이 초과되었습니다. 파일 정보는 저장 전에 직접 확인해 주세요.");
    return { filename, mimeType: null, sizeBytes: null };
  }
}

function parseDurationSeconds(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildQuestions(platform: string) {
  const linkedSourceNote =
    platform === "Direct video"
      ? "직접 영상 URL은 미리보기 메타데이터를 더 채울 수 있지만, 속도 보정값은 직접 입력해야 합니다."
      : "외부 플랫폼 영상은 원본 프레임 값을 자동으로 읽기 어렵기 때문에 검증값 입력이 필요합니다.";

  return [
    {
      field: "knownSpeedKmh",
      label: "실제 속도",
      prompt: "스피드건, 공식 기록, 신뢰 가능한 측정값을 km/h로 입력해 주세요.",
      required: true,
    },
    {
      field: "measuredSpeedKmh",
      label: "앱 분석 속도",
      prompt: "같은 영상으로 앱이 계산한 속도를 입력하면 보정 계수를 만들 수 있습니다.",
      required: true,
    },
    {
      field: "timingStartSeconds",
      label: "킥 구간",
      prompt: "공을 차는 순간과 기준 지점 도달 순간을 초 단위로 지정해 주세요.",
      required: false,
    },
    {
      field: "knownDistanceMeters",
      label: "거리 기준",
      prompt: "페널티 지점, 골대, 라인 등 실제 거리를 알 수 있는 기준을 입력해 주세요.",
      required: false,
    },
    {
      field: "cameraAngle",
      label: "촬영 조건",
      prompt: linkedSourceNote,
      required: false,
    },
  ];
}

export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const sourceUrl = sanitizeSourceUrl(body.sourceUrl);

    if ("error" in sourceUrl) {
      return NextResponse.json({ error: sourceUrl.error }, { status: 400 });
    }

    const url = sourceUrl.value;
    const warnings: string[] = [];
    const platform = getPlatform(url);
    const [oembed, directVideo] = await Promise.all([
      fetchOEmbed(url, warnings),
      fetchDirectVideoMetadata(url, warnings),
    ]);

    const providerName = sanitizeText(oembed?.provider_name, 80) ?? platform;
    const title = sanitizeText(oembed?.title, 120);
    const authorName = sanitizeText(oembed?.author_name, 120);
    const thumbnailUrl = sanitizeText(oembed?.thumbnail_url, 500) ?? getFallbackThumbnailUrl(url);
    const durationSeconds = parseDurationSeconds(oembed?.duration);
    const suggestedLabel = sanitizeText(title, MAX_LABEL_LENGTH) ?? `${platform} reference`;
    const sourceMimeType =
      directVideo.mimeType ?? (platform === "Direct video" ? "video/link" : "text/html");

    const notes = [
      "링크 분석 초안",
      `플랫폼: ${providerName}`,
      title ? `제목: ${title}` : null,
      authorName ? `작성자: ${authorName}` : null,
      "확인 필요: 실제 속도, 앱 분석 속도, 킥 구간, 거리 기준",
    ]
      .filter(Boolean)
      .join(" · ");

    if (!oembed && platform !== "Direct video") {
      warnings.push("플랫폼이 공개 메타데이터를 제공하지 않아 제목/작성자 정보를 자동 확정하지 못했습니다.");
    }

    return NextResponse.json({
      analysis: {
        sourceUrl: url.toString(),
        platform,
        providerName,
        title,
        authorName,
        thumbnailUrl,
        embedUrl: getEmbedUrl(url),
        sourceFilename: directVideo.filename,
        sourceMimeType,
        sourceSizeBytes: directVideo.sizeBytes,
        durationSeconds,
        suggestedLabel,
        suggestedNotes: notes.slice(0, MAX_NOTES_LENGTH),
        suggestedTags: [
          platform.toLowerCase().replace(/\s+/g, "-"),
          "linked-source",
          "needs-speed-check",
        ],
        questions: buildQuestions(platform),
        warnings,
      },
    });
  } catch (error) {
    console.error("Failed to analyze reference link:", error);
    return NextResponse.json({ error: "Failed to analyze reference link." }, { status: 500 });
  }
}
