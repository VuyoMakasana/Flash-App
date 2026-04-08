const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getOptional, isProd } = require("../config/env");

class S3Service {
  constructor() {
    this.s3 = null;
    this.isConfigured = false;

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const region = process.env.AWS_REGION || "af-south-1";

    // Check if S3 is properly configured
    const hasValidConfig =
      accessKeyId &&
      accessKeyId !== "your_aws_access_key" &&
      !accessKeyId.startsWith("AKIA"); // Ensure it's not clearly fake

    if (hasValidConfig && process.env.AWS_SECRET_ACCESS_KEY) {
      try {
        this.s3 = new S3Client({
          region,
          credentials: {
            accessKeyId,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });
        this.isConfigured = true;
        console.log("[S3] AWS S3 configured successfully");
      } catch (e) {
        console.warn("[S3] Failed to initialize S3 client:", e.message);
        if (isProd) {
          console.error(
            "[S3] CRITICAL: S3 initialization failed in production environment",
          );
        }
        this.isConfigured = false;
      }
    } else if (isProd && !hasValidConfig) {
      console.error(
        "[S3] CRITICAL: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be properly configured in production",
      );
    } else if (!hasValidConfig) {
      console.warn(
        "[S3] ℹ️  AWS S3 not properly configured. File uploads will use placeholder URLs. Set AWS credentials for production.",
      );
    }

    if (!process.env.AWS_S3_BUCKET && this.isConfigured) {
      console.warn(
        "[S3] ⚠️  AWS_S3_BUCKET not configured. S3 uploads may fail.",
      );
    }
  }

  async uploadFile(buffer, filename, mimetype) {
    // If S3 not configured, use safe development placeholder
    if (!this.isConfigured) {
      if (isProd) {
        throw new Error(
          "[S3] File upload unavailable: AWS S3 not configured in production. Please set AWS credentials.",
        );
      }
      console.log(`[S3] [DEV] Simulating upload of ${filename}`);
      return `https://placeholder-s3.local/${Date.now()}-${filename}`;
    }

    // Validate bucket is configured
    if (!process.env.AWS_S3_BUCKET) {
      throw new Error("[S3] AWS_S3_BUCKET not configured");
    }

    try {
      const key = `driver-docs/${Date.now()}-${filename}`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
          ServerSideEncryption: "AES256",
        }),
      );
        // VERIFIED/FIXED: No public ACL is set on uploads — all documents are private.
        // Use bucket policy to block all public access in AWS console.

      const region = process.env.AWS_REGION || "af-south-1";
      return `https://${process.env.AWS_S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
    } catch (err) {
      console.error("[S3] Upload failed:", err.message);
      if (isProd) {
        throw new Error("[S3] Failed to upload file to S3. Please try again.");
      }
      // In dev, allow graceful degradation
      console.warn(
        "[S3] [DEV] Using placeholder URL due to S3 error:",
        err.message,
      );
      return `https://placeholder-s3.local/${Date.now()}-${filename}`;
    }
  }
}

module.exports = new S3Service();
// ADDED: Signed URL generator for private document access
// WHY: Documents are private — to display them they need temporary signed URLs
// that expire after a short time rather than permanent public URLs
S3Service.prototype.getSignedUrl = async function(key, expiresInSeconds = 300) {
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const command = new GetObjectCommand({ Bucket: this.bucket || process.env.AWS_S3_BUCKET, Key: key });
  return await getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
};
