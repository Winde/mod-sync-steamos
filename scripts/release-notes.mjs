// Builds a release body from the commits between two tags.
//
// A commit body is the release notes; a commit without one contributes a single
// line from its subject. Repository-only commits (`release:`, `ci:`, `chore:`,
// `test:`, `build:`, `style:`, `deps:`) are left out.
//
//   node scripts/release-notes.mjs v0.2.1
//   node scripts/release-notes.mjs v0.2.0 v0.2.1
//
// The first form compares with the tag before the one given. Markdown goes to
// stdout; an empty result fails, so a release cannot publish with no notes.

import { execFileSync } from "node:child_process";

const SHIPPED_ONLY = /^(release|ci|chore|test|build|style|deps)(\([^)]*\))?!?:/i;
const PREFIX = /^[a-z][a-z0-9-]*(\([^)]*\))?!?:\s*/i;
const FIELD = "\x1f";
const RECORD = "\x1e";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function previousTag(tag) {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${tag}^`]);
  } catch {
    return "";
  }
}

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = git(["config", "--get", "remote.origin.url"]);
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function commits(range) {
  if (!range) return [];
  return git(["log", "--no-merges", "--reverse", "--format=%s%x1f%b%x1e", range])
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const split = record.indexOf(FIELD);
      return {
        subject: record.slice(0, split).trim(),
        body: record.slice(split + 1).trim(),
      };
    });
}

function sentence(subject) {
  const text = subject.replace(PREFIX, "").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function render(range, tag, from) {
  const blocks = [];
  const bullets = [];

  const flush = () => {
    if (bullets.length === 0) return;
    blocks.push(`## Changes\n\n${bullets.join("\n")}`);
    bullets.length = 0;
  };

  for (const commit of commits(range)) {
    if (SHIPPED_ONLY.test(commit.subject)) continue;
    if (commit.body) {
      flush();
      blocks.push(commit.body);
    } else {
      bullets.push(`- ${sentence(commit.subject)}`);
    }
  }
  flush();

  if (blocks.length === 0) {
    const where = from ? `${from}..${tag}` : tag;
    throw new Error(
      `nothing to announce in ${where}. Write the notes into the commit bodies, or into the commits the tag covers.`,
    );
  }

  let notes = blocks.join("\n\n");
  const slug = from ? repoSlug() : "";
  if (slug) {
    notes += `\n\n**Full Changelog**: https://github.com/${slug}/compare/${from}...${tag}`;
  }
  return notes;
}

function main() {
  const [first = "", second = ""] = process.argv.slice(2);
  if (!first) throw new Error("usage: release-notes.mjs [<from>] <tag>");
  const tag = second || first;
  const from = second ? first : previousTag(tag);
  process.stdout.write(`${render(from ? `${from}..${tag}` : tag, tag, from)}\n`);
}

try {
  main();
} catch (error) {
  const detail = error.stderr ? error.stderr.toString().trim() : error.message;
  console.error(`release-notes: ${detail}`);
  process.exit(1);
}
