/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, fetch, Blob */

import * as config from "./config.js";
import * as bookmarks from "./bookmarks.js";
import * as companion from "./companion.js";
import * as business from "./business.js";
import * as editor from "./editor.js";
import { launchWebAuthFlow, extractAuthCode } from "./tabs-util.js";
import * as ui from "./../../ui/bg/index.js";
import * as woleet from "./../../lib/woleet/woleet.js";
import { GDrive } from "./../../lib/gdrive/gdrive.js";
import { WebDAV } from "./../../lib/webdav/webdav.js";
import { GitHub } from "./../../lib/github/github.js";
import { download } from "./download-util.js";
import * as yabson from "./../../lib/yabson/yabson.js";
import * as offscreen from "./offscreen.js";

const partialContents = new Map();
const tabData = new Map();
const MIMETYPE_HTML = "text/html";
const GDRIVE_CLIENT_ID = "207618107333-7tjs1im1pighftpoepea2kvkubnfjj44.apps.googleusercontent.com";
const GDRIVE_CLIENT_KEY = "VQJ8Gq8Vxx72QyxPyeLtWvUt";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const CONFLICT_ACTION_SKIP = "skip";
const CONFLICT_ACTION_UNIQUIFY = "uniquify";
const REGEXP_ESCAPE = /([{}()^$&.*?/+|[\\\\]|\]|-)/g;

const gDrive = new GDrive(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_KEY, SCOPES);
export {
	onMessage,
	downloadPage,
	testSkipSave,
	saveToGDrive,
	saveToGitHub,
	saveWithWebDAV,
	encodeSharpCharacter
};

async function onMessage(message, sender) {
	if (message.method.endsWith(".download")) {
		return downloadTabPage(message, sender.tab);
	}
	if (message.method.endsWith(".disableGDrive")) {
		const authInfo = await config.getAuthInfo();
		config.removeAuthInfo();
		await gDrive.revokeAuthToken(authInfo && (authInfo.accessToken || authInfo.revokableAccessToken));
		return {};
	}
	if (message.method.endsWith(".end")) {
		if (message.hash) {
			try {
				await woleet.anchor(message.hash, message.woleetKey);
			} catch (error) {
				ui.onError(sender.tab.id, error.message, error.link);
			}
		}
		business.onSaveEnd(message.taskId);
		return {};
	}
	if (message.method.endsWith(".getInfo")) {
		return business.getTasksInfo();
	}
	if (message.method.endsWith(".cancel")) {
		business.cancelTask(message.taskId);
		return {};
	}
	if (message.method.endsWith(".cancelAll")) {
		business.cancelAllTasks();
		return {};
	}
	if (message.method.endsWith(".saveUrls")) {
		business.saveUrls(message.urls);
		return {};
	}
}

async function downloadTabPage(message, tab) {
	const tabId = tab.id;
	let contents;
	if (message.blobURL) {
		try {
			message.url = message.blobURL;
			if (message.compressContent) {
				message.pageData = await yabson.parse(new Uint8Array(await (await fetch(message.blobURL)).arrayBuffer()));
				await downloadCompressedContent(message, tab);
			} else {
				message.content = await (await fetch(message.blobURL)).text();
				await downloadContent(message, tab);
			}
		} catch (error) {
			return { error: true };
		} finally {
			await offscreen.revokeObjectURL(message.blobURL);
		}
	} else if (message.compressContent) {
		let blobParts = tabData.get(tabId);
		if (!blobParts) {
			blobParts = [];
			tabData.set(tabId, blobParts);
		}
		if (message.data) {
			blobParts.push(new Uint8Array(message.data));
		} else {
			tabData.delete(tabId);
			const message = await yabson.parse(new Uint8Array((await new Blob(blobParts).arrayBuffer())));
			await downloadCompressedContent(message, tab);
		}
	} else {
		if (message.truncated) {
			contents = partialContents.get(tabId);
			if (!contents) {
				contents = [];
				partialContents.set(tabId, contents);
			}
			contents.push(message.content);
			if (message.finished) {
				partialContents.delete(tabId);
			}
		} else if (message.content) {
			contents = [message.content];
		}
		if (!message.truncated || message.finished) {
			await downloadContent(message, tab);
		}
	}
	return {};
}

async function downloadContent(message, tab) {
	const tabId = tab.id;
	try {
		let skipped;
		if (message.backgroundSave && !message.saveToGDrive && !message.saveWithWebDAV && !message.saveToGitHub) {
			const testSkip = await testSkipSave(message.filename, message);
			message.filenameConflictAction = testSkip.filenameConflictAction;
			skipped = testSkip.skipped;
		}
		if (skipped) {
			ui.onEnd(tabId);
		} else {
			const prompt = filename => promptFilename(tabId, filename);
			let response;
			if (message.openEditor) {
				ui.onEdit(tabId);
				await editor.open({ tabIndex: tab.index + 1, filename: message.filename, content: message.content });
			} else if (message.saveToClipboard) {
				ui.onEnd(tabId);
			} else if (message.saveWithWebDAV) {
				response = await saveWithWebDAV(message.taskId, encodeSharpCharacter(message.filename), message.content, message.webDAVURL, message.webDAVUser, message.webDAVPassword, { filenameConflictAction: message.filenameConflictAction, prompt });
			} else if (message.saveToGDrive) {
				await saveToGDrive(message.taskId, encodeSharpCharacter(message.filename), new Blob(message.content, { type: MIMETYPE_HTML }), {
					forceWebAuthFlow: message.forceWebAuthFlow
				}, {
					onProgress: (offset, size) => ui.onUploadProgress(tabId, offset, size),
					filenameConflictAction: message.filenameConflictAction,
					prompt
				});
			} else if (message.saveToGitHub) {
				response = await saveToGitHub(message.taskId, encodeSharpCharacter(message.filename), message.content, message.githubToken, message.githubUser, message.githubRepository, message.githubBranch, {
					filenameConflictAction: message.filenameConflictAction,
					prompt
				});
				await response.pushPromise;
			} else if (message.saveWithCompanion) {
				await companion.save({
					filename: message.filename,
					content: message.content,
					filenameConflictAction: message.filenameConflictAction
				});
			} else {
				response = await downloadPage(message, {
					confirmFilename: message.confirmFilename,
					incognito: tab.incognito,
					filenameConflictAction: message.filenameConflictAction,
					filenameReplacementCharacter: message.filenameReplacementCharacter,
					bookmarkId: message.bookmarkId,
					replaceBookmarkURL: message.replaceBookmarkURL,
					includeInfobar: message.includeInfobar
				});
			}
			if (message.replaceBookmarkURL && response && response.url) {
				await bookmarks.update(message.bookmarkId, { url: response.url });
			}
			ui.onEnd(tabId);
			if (message.openSavedPage) {
				const createTabProperties = { active: true, url: "/src/ui/pages/viewer.html?blobURI=" + message.url };
				if (tab.index != null) {
					createTabProperties.index = tab.index + 1;
				}
				browser.tabs.create(createTabProperties);
			}
		}
	} catch (error) {
		if (!error.message || error.message != "upload_cancelled") {
			console.error(error); // eslint-disable-line no-console
			ui.onError(tabId, error.message, error.link);
		}
	} finally {
		if (!message.openSavedPage && message.url) {
			await offscreen.revokeObjectURL(message.url);
		}
	}
}

async function downloadCompressedContent(message, tab) {
	const tabId = tab.id;
	let result;
	try {
		const prompt = filename => promptFilename(tabId, filename);
		let skipped, response;
		if (message.backgroundSave && !message.saveToGDrive && !message.saveWithWebDAV && !message.saveToGitHub) {
			const testSkip = await testSkipSave(message.filename, message);
			message.filenameConflictAction = testSkip.filenameConflictAction;
			skipped = testSkip.skipped;
		}
		if (skipped) {
			ui.onEnd(tabId);
		} else {
			result = await offscreen.compressPage(message.pageData, {
				insertTextBody: message.insertTextBody,
				url: message.pageData.url || tab.url,
				createRootDirectory: message.createRootDirectory,
				tabId,
				selfExtractingArchive: message.selfExtractingArchive,
				extractDataFromPage: message.extractDataFromPage,
				insertCanonicalLink: message.insertCanonicalLink,
				insertMetaNoIndex: message.insertMetaNoIndex,
				password: message.password
			});
			if (message.openEditor) {
				ui.onEdit(tabId);
				const content = Array.from(new Uint8Array(await (await fetch(result.url)).arrayBuffer()));
				await editor.open({
					tabIndex: tab.index + 1,
					filename: message.filename,
					content,
					compressContent: message.compressContent,
					selfExtractingArchive: message.selfExtractingArchive,
					extractDataFromPage: message.extractDataFromPage,
					insertTextBody: message.insertTextBody
				});
			} else if (message.foregroundSave) {
				const blob = (await fetch(result.url)).blob();
				await downloadPageForeground(message.taskId, message.filename, blob, tabId, message.foregroundSave);
			} else if (message.saveWithWebDAV) {
				const blob = await (await fetch(result.url)).blob();
				response = await saveWithWebDAV(message.taskId, encodeSharpCharacter(message.filename), blob, message.webDAVURL, message.webDAVUser, message.webDAVPassword, { filenameConflictAction: message.filenameConflictAction, prompt });
			} else if (message.saveToGDrive) {
				const blob = await (await fetch(result.url)).blob();
				await saveToGDrive(message.taskId, encodeSharpCharacter(message.filename), blob, {
					forceWebAuthFlow: message.forceWebAuthFlow
				}, {
					onProgress: (offset, size) => ui.onUploadProgress(tabId, offset, size),
					filenameConflictAction: message.filenameConflictAction,
					prompt
				});
			} else if (message.saveToGitHub) {
				const blob = await (await fetch(result.url)).blob();
				response = await saveToGitHub(message.taskId, encodeSharpCharacter(message.filename), blob, message.githubToken, message.githubUser, message.githubRepository, message.githubBranch, {
					filenameConflictAction: message.filenameConflictAction,
					prompt
				});
				await response.pushPromise;
			} else {
				if (message.backgroundSave) {
					message.url = result.url;
					response = await downloadPage(message, {
						confirmFilename: message.confirmFilename,
						incognito: tab.incognito,
						filenameConflictAction: message.filenameConflictAction,
						filenameReplacementCharacter: message.filenameReplacementCharacter,
						bookmarkId: message.bookmarkId,
						replaceBookmarkURL: message.replaceBookmarkURL,
						includeInfobar: message.includeInfobar
					});
				} else {
					const blob = await (await fetch(result.url)).blob();
					await downloadPageForeground(message.taskId, message.filename, blob, tabId);
				}
			}
			if (message.bookmarkId && message.replaceBookmarkURL && response && response.url) {
				await bookmarks.update(message.bookmarkId, { url: response.url });
			}
			ui.onEnd(tabId);
			if (message.openSavedPage) {
				const createTabProperties = { active: true, url: "/src/ui/pages/viewer.html?compressed&blobURI=" + result.url, windowId: tab.windowId };
				if (tab.index != null) {
					createTabProperties.index = tab.index + 1;
				}
				browser.tabs.create(createTabProperties);
			}
		}
	} catch (error) {
		if (!error.message || error.message != "upload_cancelled") {
			console.error(error); // eslint-disable-line no-console
			ui.onError(tabId, error.message, error.link);
		}
	} finally {
		if (!message.openSavedPage && result.url) {
			await offscreen.revokeObjectURL(result.url);
		}
	}
}

function encodeSharpCharacter(path) {
	return path.replace(/#/g, "%23");
}

function getRegExp(string) {
	return string.replace(REGEXP_ESCAPE, "\\$1");
}

async function getAuthInfo(authOptions, force) {
	let authInfo = await config.getAuthInfo();
	const options = {
		interactive: true,
		forceWebAuthFlow: authOptions.forceWebAuthFlow,
		launchWebAuthFlow: options => launchWebAuthFlow(options),
		extractAuthCode: authURL => extractAuthCode(authURL)
	};
	gDrive.setAuthInfo(authInfo, options);
	if (!authInfo || !authInfo.accessToken || force) {
		authInfo = await gDrive.auth(options);
		if (authInfo) {
			await config.setAuthInfo(authInfo);
		} else {
			await config.removeAuthInfo();
		}
	}
	return authInfo;
}

async function saveToGitHub(taskId, filename, content, githubToken, githubUser, githubRepository, githubBranch, { filenameConflictAction, prompt }) {
	try {
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			const client = new GitHub(githubToken, githubUser, githubRepository, githubBranch);
			business.setCancelCallback(taskId, () => client.abort());
			return await client.upload(filename, content, { filenameConflictAction, prompt });
		}
	} catch (error) {
		throw new Error(error.message + " (GitHub)");
	}
}

async function saveWithWebDAV(taskId, filename, content, url, username, password, { filenameConflictAction, prompt }) {
	try {
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			const client = new WebDAV(url, username, password);
			business.setCancelCallback(taskId, () => client.abort());
			return await client.upload(filename, content, { filenameConflictAction, prompt });
		}
	} catch (error) {
		throw new Error(error.message + " (WebDAV)");
	}
}

async function saveToGDrive(taskId, filename, blob, authOptions, uploadOptions) {
	try {
		await getAuthInfo(authOptions);
		const taskInfo = business.getTaskInfo(taskId);
		if (!taskInfo || !taskInfo.cancelled) {
			return await gDrive.upload(filename, blob, uploadOptions, callback => business.setCancelCallback(taskId, callback));
		}
	}
	catch (error) {
		if (error.message == "invalid_token") {
			let authInfo;
			try {
				authInfo = await gDrive.refreshAuthToken();
			} catch (error) {
				if (error.message == "unknown_token") {
					authInfo = await getAuthInfo(authOptions, true);
				} else {
					throw new Error(error.message + " (Google Drive)");
				}
			}
			if (authInfo) {
				await config.setAuthInfo(authInfo);
			} else {
				await config.removeAuthInfo();
			}
			return await saveToGDrive(taskId, filename, blob, authOptions, uploadOptions);
		} else {
			throw new Error(error.message + " (Google Drive)");
		}
	}
}

async function testSkipSave(filename, options) {
	let skipped, filenameConflictAction = options.filenameConflictAction;
	if (filenameConflictAction == CONFLICT_ACTION_SKIP) {
		const downloadItems = await browser.downloads.search({
			filenameRegex: "(\\\\|/)" + getRegExp(filename) + "$",
			exists: true
		});
		if (downloadItems.length) {
			skipped = true;
		} else {
			filenameConflictAction = CONFLICT_ACTION_UNIQUIFY;
		}
	}
	return { skipped, filenameConflictAction };
}

function promptFilename(tabId, filename) {
	return browser.tabs.sendMessage(tabId, { method: "content.prompt", message: "Filename conflict, please enter a new filename", value: filename });
}

async function downloadPage(pageData, options) {
	const downloadInfo = {
		url: pageData.url,
		saveAs: options.confirmFilename,
		filename: pageData.filename,
		conflictAction: options.filenameConflictAction
	};
	if (options.incognito) {
		downloadInfo.incognito = true;
	}
	const downloadData = await download(downloadInfo, options.filenameReplacementCharacter);
	if (downloadData.filename) {
		let url = downloadData.filename;
		if (!url.startsWith("file:")) {
			if (url.startsWith("/")) {
				url = url.substring(1);
			}
			url = "file:///" + encodeSharpCharacter(url);
		}
		return { url };
	}
}

async function downloadPageForeground(taskId, filename, content, tabId, foregroundSave) {
	const serializer = yabson.getSerializer({ filename, taskId, foregroundSave, content: await content.arrayBuffer() });
	for await (const data of serializer) {
		await browser.tabs.sendMessage(tabId, {
			method: "content.download",
			data: Array.from(data)
		});
	}
	await browser.tabs.sendMessage(tabId, { method: "content.download" });
}