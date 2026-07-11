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
    // H15 FIX: previously warned and returned {url: null}, which callers
    // (Driver.uploadDocument) stored directly as driver_documents.file_url —
    // a driver's KYC upload would appear to succeed while silently storing
    // nothing, discoverable only by an admin manually opening the document
    // later. Throwing surfaces the failure immediately to the driver so they
    // can retry instead of believing their documents are on file.
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      throw new Error('Document storage is not configured. Please contact support.');
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
          // H-access-audit FIX: result.secure_url on an authenticated upload
          // is a permanently-valid signed URL, not a short-lived one — the
          // caller used to store/return this directly, so a driver's KYC
          // document stayed accessible forever to anyone who ever saw the
          // URL. Callers must now store publicId + resourceType and call
          // getSignedUrl() at the moment access is actually needed.
          resolve({
            publicId: result.public_id,
            resourceType: result.resource_type,
          });
        }
      );
      uploadStream.end(file.buffer);
    });
  }

  // Generate a signed, time-limited URL for private document access.
  // H-access-audit FIX: this function was already dead code (never called)
  // and, separately, actually broken — it never passed resource_type (so
  // cloudinary.utils.api_url() silently defaulted to 'image', producing a
  // wrong endpoint for any PDF/raw document) or type (so the signed
  // request didn't correctly target an `authenticated`-delivery asset),
  // and passed the literal string 'auto' as the download `format`, which
  // is not a real Cloudinary format. None of this was ever caught because
  // nothing called it. Fixed and now actually wired up in Admin.getDriverById.
  async getSignedUrl(publicId, resourceType = 'image', expiresInSeconds = 300) {
    if (!publicId) return null;
    return cloudinary.utils.private_download_url(publicId, null, {
      resource_type: resourceType,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }

  // Delete a file from Cloudinary.
  // H-access-audit FIX: previously called destroy(publicId) with no type/
  // resource_type — Cloudinary defaults those to 'upload'/'image', which
  // never matches this app's actual authenticated, often-raw-typed
  // documents, so deletion silently no-opped ({"result":"not found"}) for
  // every real document. Callers must now pass the resourceType stored
  // alongside publicId at upload time.
  async deleteFile(publicId, resourceType = 'image') {
    if (!publicId) return;
    return cloudinary.uploader.destroy(publicId, {
      type: 'authenticated',
      resource_type: resourceType,
    });
  }
}

module.exports = new S3Service();