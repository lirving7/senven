-- Migration #19：用户自带 LLM API Key（单用户单 Key，可逆加密存储）
-- 仅新增两个可空列；不加 unique / index；现有用户数据零影响（NULL = 未配置自有 Key）。
-- 明文 Key 永不落库：服务端以 AES-256-GCM 加密（AAD 绑定 userId）后写入 llmApiKeyCipher。
-- 授权：ChatGPT Implementation 授权书（2026-09-21）§二。
ALTER TABLE "User" ADD COLUMN "llmApiKeyCipher" TEXT,
                  ADD COLUMN "llmApiKeyLast4" TEXT;
