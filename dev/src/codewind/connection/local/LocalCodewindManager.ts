/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

import * as vscode from "vscode";

import { CodewindStates } from "./CodewindStates";
import CLIWrapper from "../CLIWrapper";
import MCUtil from "../../../MCUtil";
import Log from "../../../Logger";
import Connection from "../Connection";
import { CLILifecycleWrapper } from "./CLILifecycleWrapper";
import CodewindEventListener from "../CodewindEventListener";
import ConnectionManager from "../ConnectionManager";
import Resources from "../../../constants/Resources";
import Commands from "../../../constants/Commands";
import Requester from "../../project/Requester";
import CWDocs from "../../../constants/CWDocs";

const CHE_CW_URL = "https://localhost:9090";

/**
 * This singleton class wraps the local Codewind connection, which exists if CW is running locally,
 * and controls the local Codewind containers' lifecycle.
 */
export default class LocalCodewindManager {

    private static _instance: LocalCodewindManager;

    private _localConnection: Connection | undefined;
    private _state: CodewindStates = CodewindStates.STOPPED;

    public static get instance(): LocalCodewindManager {
        if (this._instance == null) {
            this._instance = new this();
        }
        return this._instance;
    }

    public get localConnection(): Connection | undefined {
        return this._localConnection;
    }

    public get isStarted(): boolean {
        return this._state === CodewindStates.STARTED || this._state === CodewindStates.STOPPING;
    }

    public get state(): CodewindStates {
        return this._state;
    }

    ///// Start/Stop Codewind /////

    public async startCodewind(): Promise<void> {
        let cwUrl: vscode.Uri;
        try {
            cwUrl = await this.startCodewindInner();
        }
        catch (err) {
            if (!CLIWrapper.isCancellation(err)) {
                CLIWrapper.showCLIError(MCUtil.errToString(err));
            }
            return;
        }

        this.connect(cwUrl);
    }

    /**
     * Create a local connection to the given codewind URL. Sets this manager's local connection, and sets the state to Started.
     */
    public async connect(cwUrl: vscode.Uri): Promise<void> {
        try {
            this._localConnection = await ConnectionManager.instance.connectLocal(cwUrl);
            this.changeState(CodewindStates.STARTED);
        }
        catch (err) {
            Log.e("Error connecting to Codewind after it should have started", err);
            this.changeState(CodewindStates.ERR_CONNECTING);
            vscode.window.showErrorMessage(MCUtil.errToString(err));
        }
    }

    /**
     * Installs and starts Codewind, if required. Will exit immediately if already started.
     * @returns The URL to the running Codewind instance, or undefined if it did not appear to start successfully.
     */
    private async startCodewindInner(): Promise<vscode.Uri> {
        await CLILifecycleWrapper.installAndStart();

        let cwUrl: vscode.Uri | undefined;
        try {
            cwUrl = await CLILifecycleWrapper.getCodewindUrl();
            if (!cwUrl) {
                throw new Error("Could not determine Codewind URL");
            }

        }
        catch (err) {
            Log.e("Error getting URL after Codewind should have started", err);
            this.changeState(CodewindStates.ERR_CONNECTING);
            throw err;
        }
        Log.i("Codewind appears to have started at " + cwUrl);
        return cwUrl;
    }

    public async stopCodewind(): Promise<void> {
        await CLILifecycleWrapper.stop();
        this._localConnection = undefined;
    }

    /**
     * Check if the local Codewind URL has changed due to a command-line restart, and recreate the local connection if it has changed.
     */
    public async refresh(): Promise<boolean> {
        const cwUrl = await CLILifecycleWrapper.getCodewindUrl();
        if (this.localConnection && cwUrl && cwUrl !== this.localConnection.url) {
            // If the URL has changed, dispose of the old connection, and connect to the new PFE.
            await ConnectionManager.instance.removeConnection(this.localConnection);
            await this.connect(cwUrl);
            return true;
        }
        return false;
    }

    public changeState(newState: CodewindStates): void {
        Log.d(`Local Codewind state changing from ${this._state} to ${newState}`);
        this._state = newState;
        CodewindEventListener.onChange(this);
    }

    /**
     * Theia Only -
     * For the theia case where we do not control CW's lifecycle, we simply wait for it to start.
     */
    public async waitForCodewindToStartTheia(): Promise<void> {
        Log.i(`In theia; waiting for Codewind to come up on ${CHE_CW_URL}`);
        this.changeState(CodewindStates.STARTING);
        const cheCwUrl = vscode.Uri.parse(CHE_CW_URL);

        // This looks awfully similar to Requester.waitForReady, but here we're just testing for a listening port.
        const timeoutS = 180;
        const delayS = 2;
        const maxTries = timeoutS / delayS;
        const longerThanUsualTries = Math.round(maxTries / 2);

        let tries = 0;
        const waitingForReadyProm = new Promise<boolean>((resolve) => {
            const interval = setInterval(async () => {
                tries++;
                const pingResult = await Requester.ping(CHE_CW_URL);
                if (pingResult) {
                    clearInterval(interval);
                    return resolve(true);
                }
                else if (tries > maxTries) {
                    clearInterval(interval);
                    return resolve(false);
                }
                else if (tries === longerThanUsualTries) {
                    this.onTheiaStartTimeout(false, tries * delayS);
                }
            }, delayS * 1000);
        }).then((result) => {
            if (result) {
                Log.i(`Codewind pod came up after ${tries} tries`);
            }
            else {
                Log.e(`Codewind pod did NOT come up after ${tries} tries`);
            }
            return result;
        });

        vscode.window.setStatusBarMessage(`${Resources.getOcticon(Resources.Octicons.sync, true)}` +
            `Waiting for Codewind to start...`, waitingForReadyProm);
        await waitingForReadyProm;

        const isCodewindUp = await waitingForReadyProm;
        if (!isCodewindUp) {
            this.onTheiaStartTimeout(true, timeoutS);
            this.changeState(CodewindStates.ERR_CONNECTING);
            return;
        }

        await this.connect(cheCwUrl);
    }

    private onTheiaStartTimeout(failure: boolean, secsElapsed: number): void {
        const helpBtn = "Help";

        const msg = failure ?
            `Codewind failed to come up after ${secsElapsed} seconds. ` +
            `Check the status of the Codewind pod, and click ${helpBtn} to open our documentation. ` +
            `Refresh the page to restart the connection process.` :
            `Codewind is taking longer than usual to start -  Check the status of the Codewind pod, and click ${helpBtn} to open our documentation.`;

        const showMsgFunc = failure ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;

        showMsgFunc(msg, helpBtn)
        .then((res) => {
            if (res === helpBtn) {
                vscode.commands.executeCommand(Commands.VSC_OPEN, CWDocs.getDocLink(CWDocs.INSTALL_ON_CLOUD));
            }
        });
    }
}
