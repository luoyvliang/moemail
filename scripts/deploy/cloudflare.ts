import Cloudflare from "cloudflare";
import "dotenv/config";

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const PROJECT_NAME = process.env.PROJECT_NAME || "moemail";
const DATABASE_NAME = process.env.DATABASE_NAME || "moemail-db";
const KV_NAMESPACE_NAME = process.env.KV_NAMESPACE_NAME || "moemail-kv";
const DATABASE_ID = process.env.DATABASE_ID;

const client = new Cloudflare({
  apiKey: CF_API_TOKEN,
});

/**
 * 重试包装器：专门处理 node-fetch@2 的 ERR_STREAM_PREMATURE_CLOSE
 * - 只在网络级错误时重试（非业务错误）
 * - 指数退避 + 随机 jitter，防止多实例同时重试
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; label?: string }
): Promise<T> {
  const { retries = 3, label = "API call" } = options ?? {};
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isRetryable =
        (err as any)?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
        (err as any)?.type === "system" ||
        (err as any)?.code === "ECONNRESET" ||
        (err as any)?.code === "ETIMEDOUT" ||
        (err as any)?.code === "UND_ERR_SOCKET";

      if (!isRetryable || attempt === retries - 1) {
        throw err;
      }

      // 指数退避: 1s, 2s, 4s + 随机 jitter ±500ms
      const baseDelay = 1000 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 1000) - 500;
      const delay = Math.max(baseDelay + jitter, 500);

      console.warn(
        `⚠️ [${label}] 请求失败 (${attempt + 1}/${retries}), ${delay}ms 后重试:`,
        (err as Error)?.message ?? err
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

export const getPages = async () => {
  const projectInfo = await withRetry(
    () =>
      client.pages.projects.get(PROJECT_NAME, {
        account_id: CF_ACCOUNT_ID,
      }),
    { label: "getPages" }
  );

  return projectInfo;
};

export const createPages = async () => {
  console.log(`🆕 Creating new Cloudflare Pages project: "${PROJECT_NAME}"`);

  const project = await withRetry(
    () =>
      client.pages.projects.create({
        account_id: CF_ACCOUNT_ID,
        name: PROJECT_NAME,
        production_branch: "main",
      }),
    { label: "createPages" }
  );

  if (CUSTOM_DOMAIN) {
    console.log("🔗 Setting pages domain...");

    await withRetry(
      () =>
        client.pages.projects.domains.create(PROJECT_NAME, {
          account_id: CF_ACCOUNT_ID,
          name: CUSTOM_DOMAIN,
        }),
      { label: "setDomain" }
    );

    console.log("✅ Pages domain set successfully");
  }

  console.log("✅ Project created successfully");

  return project;
};

export const getDatabase = async () => {
  if (DATABASE_ID) {
    return {
      uuid: DATABASE_ID,
    };
  }

  const database = await withRetry(
    () =>
      client.d1.database.get(DATABASE_NAME, {
        account_id: CF_ACCOUNT_ID,
      }),
    { label: "getDatabase" }
  );

  return database;
};

export const createDatabase = async () => {
  console.log(`🆕 Creating new D1 database: "${DATABASE_NAME}"`);

  const database = await withRetry(
    () =>
      client.d1.database.create({
        account_id: CF_ACCOUNT_ID,
        name: DATABASE_NAME,
      }),
    { label: "createDatabase" }
  );

  console.log("✅ Database created successfully");

  return database;
};

export const getKVNamespaceList = async () => {
  const kvNamespaces: Array<{ id: string; title: string }> = [];

  for await (const namespace of client.kv.namespaces.list({
    account_id: CF_ACCOUNT_ID,
  })) {
    kvNamespaces.push(namespace);
  }

  return kvNamespaces;
};

export const createKVNamespace = async () => {
  console.log(`🆕 Creating new KV namespace: "${KV_NAMESPACE_NAME}"`);

  const kvNamespace = await withRetry(
    () =>
      client.kv.namespaces.create({
        account_id: CF_ACCOUNT_ID,
        title: KV_NAMESPACE_NAME,
      }),
    { label: "createKVNamespace" }
  );

  console.log("✅ KV namespace created successfully");

  return kvNamespace;
};
