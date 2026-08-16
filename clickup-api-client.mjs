#!/usr/bin/env node
/**
 * Small dependency-free ClickUp API v2 client for repeatable workspace setup.
 * Requires Node.js 18+ (native fetch).
 */

const API_BASE_URL = process.env.CLICKUP_API_BASE_URL || "https://api.clickup.com/api/v2";
const DEFAULT_RETRIES = numberEnv("CLICKUP_MAX_RETRIES", 6);
const DEFAULT_CONCURRENCY = numberEnv("CLICKUP_CONCURRENCY", 1);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => query.append(`${key}[]`, String(item)));
    else query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export class ClickUpApiError extends Error {
  constructor(message, { status, body, response } = {}) {
    super(message);
    this.name = "ClickUpApiError";
    this.status = status;
    this.body = body;
    this.response = response;
  }
}

export class ClickUpClient {
  constructor({ token = process.env.CLICKUP_TOKEN, baseUrl = API_BASE_URL, maxRetries = DEFAULT_RETRIES } = {}) {
    if (!token) throw new Error("Missing CLICKUP_TOKEN. Set it in the environment before creating ClickUpClient.");
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.maxRetries = maxRetries;
    this.hierarchyCache = new Map();
  }

  async request(path, { method = "GET", query, body, signal } = {}) {
    const url = `${this.baseUrl}${path}${queryString(query)}`;
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method,
          signal,
          headers: {
            Authorization: this.token,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (cause) {
        if (attempt >= this.maxRetries) throw cause;
        await sleep(this.retryDelay(attempt));
        continue;
      }

      const raw = await response.text();
      let data = raw;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* preserve non-JSON bodies */ }
      if (response.ok) return data;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        throw new ClickUpApiError(`ClickUp ${method} ${path} failed (${response.status})`, {
          status: response.status, body: data, response,
        });
      }

      await sleep(this.retryDelay(attempt, response));
    }
  }

  retryDelay(attempt, response) {
    // ClickUp exposes the next reset as a Unix timestamp in X-RateLimit-Reset.
    const reset = Number(response?.headers.get("x-ratelimit-reset"));
    if (response?.status === 429 && Number.isFinite(reset) && reset > 0) {
      return Math.max(0, reset * 1000 - Date.now()) + 250;
    }
    const retryAfter = Number(response?.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    // Capped exponential backoff with a small random jitter prevents synchronized retries.
    return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
  }

  // Workspace / hierarchy
  getWorkspaces() { return this.request("/team"); }
  getSpaces(workspaceId, { archived = false } = {}) {
    return this.request(`/team/${workspaceId}/space`, { query: { archived } });
  }
  getFolders(spaceId, { archived = false } = {}) {
    return this.request(`/space/${spaceId}/folder`, { query: { archived } });
  }
  getFolderLists(folderId, { archived = false } = {}) {
    return this.request(`/folder/${folderId}/list`, { query: { archived } });
  }
  getSpaceLists(spaceId, { archived = false } = {}) {
    return this.request(`/space/${spaceId}/list`, { query: { archived } });
  }
  getSpaceTags(spaceId) { return this.request(`/space/${spaceId}/tag`); }
  async createSpaceTag(spaceId, tag) {
    await this.request(`/space/${spaceId}/tag`, { method: "POST", body: { tag } });
    // ClickUp may return an empty response for this endpoint; return the saved tag consistently.
    const tags = (await this.getSpaceTags(spaceId)).tags || [];
    return tags.find((item) => item.name === tag.name) || { ...tag };
  }
  getList(listId) { return this.request(`/list/${listId}`); }
  getTask(taskId, { includeSubtasks = false } = {}) {
    return this.request(`/task/${taskId}`, { query: { subtasks: includeSubtasks } });
  }

  async getWorkspaceHierarchy(workspaceId, { archived = false, refresh = false } = {}) {
    const key = `${workspaceId}:${archived}`;
    if (!refresh && this.hierarchyCache.has(key)) return this.hierarchyCache.get(key);
    const spacesResponse = await this.getSpaces(workspaceId, { archived });
    const spaces = await Promise.all((spacesResponse.spaces || []).map(async (space) => {
      const [foldersResponse, folderlessListsResponse] = await Promise.all([
        this.getFolders(space.id, { archived }), this.getSpaceLists(space.id, { archived }),
      ]);
      const folders = await Promise.all((foldersResponse.folders || []).map(async (folder) => ({
        ...folder,
        lists: (await this.getFolderLists(folder.id, { archived })).lists || [],
      })));
      return { ...space, folders, lists: folderlessListsResponse.lists || [] };
    }));
    const hierarchy = { workspaceId: String(workspaceId), spaces };
    this.hierarchyCache.set(key, hierarchy);
    return hierarchy;
  }

  async findListByName(workspaceId, name, { exact = true, archived = false } = {}) {
    const needle = name.trim().toLocaleLowerCase();
    const matches = [];
    const hierarchy = await this.getWorkspaceHierarchy(workspaceId, { archived });
    for (const space of hierarchy.spaces) {
      for (const list of space.lists) if (nameMatches(list.name, needle, exact)) matches.push({ ...list, space });
      for (const folder of space.folders) {
        for (const list of folder.lists) if (nameMatches(list.name, needle, exact)) matches.push({ ...list, space, folder });
      }
    }
    return matches;
  }

  // Tasks
  async *iterateTasks(listId, options = {}) {
    const { pageSize = 100, ...rest } = options;
    for (let page = 0; ; page += 1) {
      const result = await this.request(`/list/${listId}/task`, { query: { page, ...rest } });
      const tasks = result.tasks || [];
      yield* tasks;
      // Get Tasks returns at most 100 items; a short page is the end of the collection.
      if (tasks.length < pageSize) return;
    }
  }

  async listTasks(listId, options = {}) {
    const tasks = [];
    for await (const task of this.iterateTasks(listId, options)) tasks.push(task);
    return tasks;
  }

  async findTasksByName(listId, name, { exact = true, includeSubtasks = true, includeClosed = true } = {}) {
    const needle = name.trim().toLocaleLowerCase();
    const matches = [];
    for await (const task of this.iterateTasks(listId, {
      subtasks: includeSubtasks, include_closed: includeClosed,
    })) if (nameMatches(task.name, needle, exact)) matches.push(task);
    return matches;
  }

  createTask(listId, task) { return this.request(`/list/${listId}/task`, { method: "POST", body: task }); }
  createSubtask(listId, parentTaskId, task) {
    return this.createTask(listId, { ...task, parent: String(parentTaskId) });
  }
  updateTask(taskId, changes) { return this.request(`/task/${taskId}`, { method: "PUT", body: changes }); }
  addTagToTask(taskId, tagName) {
    return this.request(`/task/${taskId}/tag/${encodeURIComponent(tagName)}`, { method: "POST" });
  }
  removeTagFromTask(taskId, tagName) {
    return this.request(`/task/${taskId}/tag/${encodeURIComponent(tagName)}`, { method: "DELETE" });
  }

  async createSubtasks(listId, parentTaskId, tasks, { concurrency = DEFAULT_CONCURRENCY } = {}) {
    if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array of task payloads");
    const results = new Array(tasks.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= tasks.length) return;
        results[index] = await this.createSubtask(listId, parentTaskId, tasks[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
    return results;
  }
}

function nameMatches(value, normalizedNeedle, exact) {
  const normalizedValue = String(value || "").trim().toLocaleLowerCase();
  return exact ? normalizedValue === normalizedNeedle : normalizedValue.includes(normalizedNeedle);
}

// Optional one-command starter: node clickup-api-client.mjs hierarchy <workspace-id>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, id] = process.argv.slice(2);
  const client = new ClickUpClient();
  if (command === "hierarchy" && id) console.log(JSON.stringify(await client.getWorkspaceHierarchy(id), null, 2));
  else if (command === "workspaces") console.log(JSON.stringify(await client.getWorkspaces(), null, 2));
  else console.error("Usage: node clickup-api-client.mjs workspaces | hierarchy <workspace-id>");
}

