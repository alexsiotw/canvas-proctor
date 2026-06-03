const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

let auth;
let drive;

try {
    if (process.env.GOOGLE_CREDENTIALS) {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        
        // Handle escaped newlines in private key
        const privateKey = credentials.private_key.replace(/\\n/g, '\n');

        auth = new google.auth.JWT(
            credentials.client_email,
            null,
            privateKey,
            ['https://www.googleapis.com/auth/drive']
        );
        drive = google.drive({ version: 'v3', auth });
        console.log('Google Drive client initialized successfully');
    } else {
        console.warn('GOOGLE_CREDENTIALS environment variable is not defined.');
    }
} catch (err) {
    console.error('Failed to initialize Google Drive client:', err.message);
}

let cachedFolderId = null;

/**
 * Auto-detects the ID of a shared folder by its name.
 * @param {string} folderName 
 * @returns {Promise<string>} The Google Drive folder ID.
 */
async function getFolderId(folderName = 'Canvas Proctor Videos') {
    if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
        return process.env.GOOGLE_DRIVE_FOLDER_ID;
    }
    if (cachedFolderId) return cachedFolderId;

    if (!drive) throw new Error("Google Drive client is not initialized.");

    // 1. Prioritize Shared Drives (Team Drives) to utilize organizational storage quotas
    try {
        const drivesRes = await drive.drives.list({
            fields: 'drives(id, name)'
        });
        const drives = drivesRes.data.drives;
        const matchingDrive = drives && drives.find(d => d.name === folderName);
        if (matchingDrive) {
            cachedFolderId = matchingDrive.id;
            console.log(`Auto-detected Google Shared Drive "${folderName}" with ID: ${cachedFolderId}`);
            return cachedFolderId;
        }
    } catch (err) {
        console.warn("Failed to list Shared Drives, falling back to folder search:", err.message);
    }

    // 2. Fallback to searching regular folders
    const response = await drive.files.list({
        q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    });

    const files = response.data.files;
    if (files && files.length > 0) {
        cachedFolderId = files[0].id;
        console.log(`Auto-detected Google Drive folder "${folderName}" with ID: ${cachedFolderId}`);
        return cachedFolderId;
    }

    throw new Error(`Google Drive folder/drive "${folderName}" was not found. Please ensure it is created and shared with the service account.`);
}

/**
 * Uploads a local file to Google Drive.
 * @param {string} filePath - Absolute path to the local file.
 * @param {string} fileName - Destination name in Google Drive.
 * @param {string} mimeType - MIME type of the file.
 * @returns {Promise<string>} The uploaded Google Drive file ID.
 */
async function uploadVideoToDrive(filePath, fileName, mimeType) {
    if (!drive) throw new Error("Google Drive client is not initialized.");

    const folderId = await getFolderId();

    const fileMetadata = {
        name: fileName,
        parents: [folderId]
    };

    const media = {
        mimeType: mimeType || 'video/webm',
        body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
        supportsAllDrives: true
    });

    return response.data.id;
}

/**
 * Downloads a file from Google Drive as a readable stream.
 * @param {string} fileId - The Google Drive file ID.
 * @returns {Promise<stream.Readable>} A readable stream of the file content.
 */
async function downloadVideoFromDrive(fileId) {
    if (!drive) throw new Error("Google Drive client is not initialized.");

    const response = await drive.files.get(
        { fileId: fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
    );

    return response.data;
}

module.exports = {
    uploadVideoToDrive,
    downloadVideoFromDrive
};
