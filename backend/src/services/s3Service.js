const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

class S3Service {
  constructor() {
    this.s3 = null;
    const hasRealS3Config =
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_ACCESS_KEY_ID !== "placeholder" &&
      process.env.AWS_ACCESS_KEY_ID !== "your_aws_access_key" &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_SECRET_ACCESS_KEY !== "placeholder" &&
      process.env.AWS_REGION &&
      process.env.AWS_S3_BUCKET;

    if (
      hasRealS3Config
    ) {
      this.s3 = new S3Client({ region: process.env.AWS_REGION });
    } else {
      console.warn(
        "[Config] AWS S3 credentials are not fully configured. Driver documents will use dev placeholder URLs.",
      );
    }
  }

  async uploadFile(buffer, filename, mimetype) {
    if (!this.s3) {
      console.log(`[DEV] Would upload ${filename} to S3`);
      return `https://placeholder-s3-url.com/${filename}`;
    }

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

    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }
}

module.exports = new S3Service();
