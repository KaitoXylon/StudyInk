/**
 * drive-sync.js — Google Drive Sync Service for StudyLink
 * Handles OAuth2 authentication and all Drive API operations.
 */

const { google } = require('googleapis');
const { shell } = require('electron');
const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Load environment variables from .env file
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── OAuth2 Configuration ────────────────────────────────────────────────────
const CREDENTIALS = {
  client_id: process.env.GOOGLE_CLIENT_ID || '',
  client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
  redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:42813/oauth2callback',
};

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

// StudyLink folder structure in Drive
const DRIVE_FOLDER_NAME = 'StudyLink';
const PDFS_SUBFOLDER = 'pdfs';
const ANNOTS_SUBFOLDER = 'annotations';

// ── Drive Sync Manager ──────────────────────────────────────────────────────
class DriveSyncManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.tokenFile = path.join(userDataPath, 'drive-token.json');
    this.oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.client_id,
      CREDENTIALS.client_secret,
      CREDENTIALS.redirect_uri
    );
    this.drive = null;
    this.folderIds = {}; // Cache: name -> Drive folder ID
    this._authCallbackServer = null;

    // Try to restore saved token on startup
    this._loadStoredToken();
  }

  // ── Token Management ──────────────────────────────────────────────────────

  _loadStoredToken() {
    try {
      if (fs.existsSync(this.tokenFile)) {
        const token = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        this.oauth2Client.setCredentials(token);
        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
        // Auto-refresh: set up token refresh listener
        this.oauth2Client.on('tokens', (tokens) => {
          if (tokens.refresh_token) {
            const current = this._getStoredToken() || {};
            this._saveToken({ ...current, ...tokens });
          } else {
            const current = this._getStoredToken() || {};
            this._saveToken({ ...current, access_token: tokens.access_token, expiry_date: tokens.expiry_date });
          }
        });
        return true;
      }
    } catch (e) {
      console.error('[DriveSync] Failed to load stored token:', e.message);
    }
    return false;
  }

  _getStoredToken() {
    try {
      if (fs.existsSync(this.tokenFile)) {
        return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      }
    } catch (e) {}
    return null;
  }

  _saveToken(token) {
    try {
      fs.writeFileSync(this.tokenFile, JSON.stringify(token, null, 2));
    } catch (e) {
      console.error('[DriveSync] Failed to save token:', e.message);
    }
  }

  isConnected() {
    if (!this.drive) return false;
    const creds = this.oauth2Client.credentials;
    return !!(creds && (creds.access_token || creds.refresh_token));
  }

  async getStatus() {
    if (!this.isConnected()) return { connected: false, email: null };
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
      const { data } = await oauth2.userinfo.get();
      return { connected: true, email: data.email, picture: data.picture };
    } catch (e) {
      return { connected: true, email: null };
    }
  }

  // ── OAuth2 Flow ───────────────────────────────────────────────────────────

  async connect() {
    if (!CREDENTIALS.client_id || !CREDENTIALS.client_secret) {
      throw new Error('Google Drive API credentials not found. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.');
    }

    return new Promise((resolve, reject) => {
      // Start a local HTTP server to catch the redirect
      if (this._authCallbackServer) {
        try { this._authCallbackServer.close(); } catch(e) {}
      }

      this._authCallbackServer = http.createServer(async (req, res) => {
        const parsed = url.parse(req.url, true);
        if (parsed.pathname !== '/oauth2callback') {
          res.end('Not found');
          return;
        }

        const code = parsed.query.code;
        const error = parsed.query.error;

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:Inter,sans-serif;text-align:center;padding:60px;background:#0f1117;color:#fff">
            <h2 style="color:#ef4444">Authorization failed</h2>
            <p>${error}</p>
            <p>You can close this tab.</p>
          </body></html>`);
          this._authCallbackServer.close();
          reject(new Error('Authorization denied: ' + error));
          return;
        }

        try {
          const { tokens } = await this.oauth2Client.getToken(code);
          this.oauth2Client.setCredentials(tokens);
          this._saveToken(tokens);
          this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });

          // Register token refresh handler
          this.oauth2Client.on('tokens', (newTokens) => {
            const current = this._getStoredToken() || {};
            this._saveToken({ ...current, ...newTokens });
          });

          // Success page
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:Inter,sans-serif;text-align:center;padding:60px;background:#0f1117;color:#fff">
            <div style="max-width:400px;margin:0 auto">
              <div style="font-size:64px;margin-bottom:16px">✅</div>
              <h2 style="color:#22c55e;margin-bottom:8px">Connected to Google Drive!</h2>
              <p style="color:#94a3b8">StudyLink is now syncing your PDFs to Drive.</p>
              <p style="color:#64748b;font-size:14px;margin-top:24px">You can close this tab and return to StudyLink.</p>
            </div>
          </body></html>`);

          this._authCallbackServer.close();
          resolve({ success: true });
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:Inter,sans-serif;text-align:center;padding:60px;background:#0f1117;color:#fff">
            <h2 style="color:#ef4444">Error</h2><p>${err.message}</p>
          </body></html>`);
          this._authCallbackServer.close();
          reject(err);
        }
      });

      this._authCallbackServer.listen(42813, () => {
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: SCOPES,
          prompt: 'consent',
        });
        shell.openExternal(authUrl);
        resolve({ success: true, pending: true }); // Resolve immediately, auth happens async
      });

      this._authCallbackServer.on('error', (err) => {
        reject(err);
      });
    });
  }

  async disconnect() {
    try {
      if (fs.existsSync(this.tokenFile)) fs.unlinkSync(this.tokenFile);
    } catch (e) {}
    this.oauth2Client.setCredentials({});
    this.drive = null;
    this.folderIds = {};
    return { success: true };
  }

  // ── Drive Folder Management ───────────────────────────────────────────────

  async _ensureFolder(name, parentId = null) {
    const cacheKey = parentId ? `${parentId}/${name}` : name;
    if (this.folderIds[cacheKey]) return this.folderIds[cacheKey];

    // Search for existing folder
    let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;

    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (res.data.files.length > 0) {
      this.folderIds[cacheKey] = res.data.files[0].id;
      return res.data.files[0].id;
    }

    // Create the folder
    const meta = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId && { parents: [parentId] }),
    };
    const created = await this.drive.files.create({ requestBody: meta, fields: 'id' });
    this.folderIds[cacheKey] = created.data.id;
    return created.data.id;
  }

  async _getStudyLinkFolders() {
    const rootId = await this._ensureFolder(DRIVE_FOLDER_NAME);
    const pdfsId = await this._ensureFolder(PDFS_SUBFOLDER, rootId);
    const annotsId = await this._ensureFolder(ANNOTS_SUBFOLDER, rootId);
    return { rootId, pdfsId, annotsId };
  }

  // ── File Upload ───────────────────────────────────────────────────────────

  async uploadPDF(localFilePath) {
    if (!this.isConnected()) throw new Error('Not connected to Drive');
    if (!fs.existsSync(localFilePath)) throw new Error('File not found: ' + localFilePath);

    const { pdfsId } = await this._getStudyLinkFolders();
    const fileName = path.basename(localFilePath);

    // Check if file already exists in Drive (for update)
    const existing = await this._findFileInFolder(fileName, pdfsId);
    const modifiedTime = new Date(fs.statSync(localFilePath).mtime).toISOString();

    const media = {
      mimeType: 'application/pdf',
      body: fs.createReadStream(localFilePath),
    };

    if (existing) {
      // Update existing file
      await this.drive.files.update({
        fileId: existing.id,
        requestBody: { modifiedTime },
        media,
        fields: 'id, modifiedTime',
      });
      return { success: true, fileId: existing.id, action: 'updated' };
    } else {
      // Create new file
      const res = await this.drive.files.create({
        requestBody: { name: fileName, parents: [pdfsId], modifiedTime },
        media,
        fields: 'id, modifiedTime',
      });
      return { success: true, fileId: res.data.id, action: 'created' };
    }
  }

  async uploadAnnotations(pdfPath, annotationData) {
    if (!this.isConnected()) throw new Error('Not connected to Drive');

    const { annotsId } = await this._getStudyLinkFolders();
    // Use same safe key as local storage
    const safeKey = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
    const fileName = `${safeKey}.json`;
    const jsonContent = JSON.stringify(annotationData, null, 2);

    const existing = await this._findFileInFolder(fileName, annotsId);
    const media = {
      mimeType: 'application/json',
      body: require('stream').Readable.from([jsonContent]),
    };

    if (existing) {
      await this.drive.files.update({
        fileId: existing.id,
        media,
        fields: 'id',
      });
      return { success: true, fileId: existing.id, action: 'updated' };
    } else {
      const res = await this.drive.files.create({
        requestBody: { name: fileName, parents: [annotsId] },
        media,
        fields: 'id',
      });
      return { success: true, fileId: res.data.id, action: 'created' };
    }
  }

  // ── File Listing ──────────────────────────────────────────────────────────

  async listFiles() {
    if (!this.isConnected()) throw new Error('Not connected to Drive');

    const { pdfsId } = await this._getStudyLinkFolders();
    const res = await this.drive.files.list({
      q: `'${pdfsId}' in parents and mimeType='application/pdf' and trashed=false`,
      fields: 'files(id, name, size, modifiedTime, createdTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
    });
    return res.data.files;
  }

  // ── File Download ─────────────────────────────────────────────────────────

  async downloadFile(fileId, localDestPath) {
    if (!this.isConnected()) throw new Error('Not connected to Drive');

    // Get Drive file metadata for conflict check
    const meta = await this.drive.files.get({
      fileId,
      fields: 'id, name, modifiedTime',
    });
    const driveMod = new Date(meta.data.modifiedTime).getTime();

    // Conflict check: if local file exists and is newer
    if (fs.existsSync(localDestPath)) {
      const localMod = new Date(fs.statSync(localDestPath).mtime).getTime();
      if (localMod > driveMod) {
        // Return conflict info — caller handles resolution
        return {
          success: false,
          conflict: true,
          localModified: localMod,
          driveModified: driveMod,
          fileId,
          localPath: localDestPath,
          fileName: meta.data.name,
        };
      }
    }

    return await this._doDownload(fileId, localDestPath);
  }

  async _doDownload(fileId, localDestPath) {
    const dest = fs.createWriteStream(localDestPath);
    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      res.data
        .on('end', () => resolve({ success: true, path: localDestPath }))
        .on('error', reject)
        .pipe(dest);
    });
  }

  async downloadAnnotations(pdfPath) {
    if (!this.isConnected()) return null;
    try {
      const { annotsId } = await this._getStudyLinkFolders();
      const safeKey = Buffer.from(pdfPath).toString('base64').replace(/[/+=]/g, '_');
      const fileName = `${safeKey}.json`;
      const existing = await this._findFileInFolder(fileName, annotsId);
      if (!existing) return null;

      const res = await this.drive.files.get(
        { fileId: existing.id, alt: 'media' },
        { responseType: 'json' }
      );
      return res.data;
    } catch (e) {
      console.error('[DriveSync] Failed to download annotations:', e.message);
      return null;
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  async _findFileInFolder(fileName, folderId) {
    const res = await this.drive.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      pageSize: 1,
    });
    return res.data.files.length > 0 ? res.data.files[0] : null;
  }

  // Force overwrite download (used after conflict resolution choosing Drive version)
  async forceDownload(fileId, localDestPath) {
    return await this._doDownload(fileId, localDestPath);
  }
}

module.exports = DriveSyncManager;
