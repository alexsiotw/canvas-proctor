const { google } = require('googleapis');
const stream = require('stream');

// Initialize Google Drive client using a service account JSON string
function getDriveClient() {
    if (!process.env.GOOGLE_CREDENTIALS_JSON) {
        throw new Error('GOOGLE_CREDENTIALS_JSON is not configured in environment variables.');
    }
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
}

// Ensure the main proctor folder exists, or create a subfolder for a specific exam
async function createFolder(folderName, parentFolderId) {
    try {
        const drive = getDriveClient();
        const response = await drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: parentFolderId ? [parentFolderId] : []
            },
            fields: 'id'
        });
        return response.data.id;
    } catch (err) {
        console.error('Drive folder creation failed:', err);
        return null;
    }
}

// Create a folder for a student's exam session
async function createStudentExamFolder(examTitle, studentName) {
    const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!rootFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required');
    return await createFolder(`[Proctor] ${examTitle} - ${studentName}`, rootFolderId);
}

// Upload a video chunk (buffer) into the student's folder
async function uploadVideoChunk(folderId, fileName, buffer, mimeType = 'video/webm') {
    try {
        const drive = getDriveClient();
        const bufferStream = stream.Readable.from(buffer);

        const response = await drive.files.create({
            resource: {
                name: fileName,
                parents: [folderId]
            },
            media: {
                mimeType: mimeType,
                body: bufferStream
            },
            fields: 'id, webViewLink'
        });
        return response.data;
    } catch (err) {
        console.error('Drive video upload failed:', err);
        throw err;
    }
}

module.exports = {
    createStudentExamFolder,
    uploadVideoChunk
};
