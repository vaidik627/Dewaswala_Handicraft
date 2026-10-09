// Cloudinary photo storage. Keys come from the hosting settings.
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// Cloudinary paths cannot contain characters such as # ? & spaces. Keep letters, digits, - and _ only.
function safeFolder(folder) {
  return String(folder).split('/')
    .map(part => part.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item')
    .join('/');
}

function upload(buffer, rawFolder) {
  const folder = safeFolder(rawFolder);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

function destroy(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { upload, destroy };
