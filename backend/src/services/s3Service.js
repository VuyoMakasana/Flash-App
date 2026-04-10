// REPLACED: AWS S3 with Cloudinary for document storage
// WHY: AWS credentials require a paid account setup and billing info.
// Cloudinary provides 25GB free storage with simpler setup — no IAM roles,
// no bucket policies, no ACL configuration needed.

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

class S3Service {
  // Upload a file buffer to Cloudinary
  async uploadFile(file, folder = 'flash-documents') {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      console.warn('[Cloudinary] Not configured — skipping upload');
      return { url: null, key: null };
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'auto',
          // Documents are private — use authenticated URLs
          type: 'authenticated',
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url: result.secure_url,
            key: result.public_id,
            publicId: result.public_id,
          });
        }
      );
      uploadStream.end(file.buffer);
    });
  }

  // Generate a signed URL for private document access (valid 5 minutes)
  async getSignedUrl(publicId, expiresInSeconds = 300) {
    if (!publicId) return null;
    return cloudinary.utils.private_download_url(publicId, 'auto', {
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }

  // Delete a file from Cloudinary
  async deleteFile(publicId) {
    if (!publicId) return;
    return cloudinary.uploader.destroy(publicId);
  }
}

module.exports = new S3Service();