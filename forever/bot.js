const EventEmitter = require('events');
const child_process = require('child_process');

const timestamp = require('time-stamp');
const fs = require('fs');
const procfs = require('procfs-stats');
const path = require("path");

const accounts = require('./acc.js');
const config = require('./config');

const LAUNCH_OPTIONS_STEAM = 'firejail %NETWORK% --noprofile --private="%HOME%" --name=%JAILNAME% --env=DISPLAY=%DISPLAY% --env=LD_PRELOAD=%LD_PRELOAD% %STEAM% -silent -login %LOGIN% %PASSWORD% -nominidumps -nobreakpad -no-browser -nofriendsui'
const LAUNCH_OPTIONS_GAME = 'firejail --join=%JAILNAME% bash -c \'cd ~/$GAMEPATH && %REPLACE_RUNTIME% LD_PRELOAD=%LD_PRELOAD% DISPLAY=%DISPLAY% ./hl2_linux -game tf -silent -sw -h 640 -w 480 -novid -nojoy -noshaderapi -nomouse -nomessagebox -nominidumps -nohltv -nobreakpad -particles 512 -snoforceformat -softparticlesdefaultoff -threads 1\''
const LAUNCH_OPTIONS_GAME_NATIVE = LAUNCH_OPTIONS_GAME.replace("%REPLACE_RUNTIME%", 'LD_LIBRARY_PATH="$LD_LIBRARY_PATH:./bin"');
const LAUNCH_OPTIONS_GAME_RUNTIME = LAUNCH_OPTIONS_GAME.replace("%REPLACE_RUNTIME%", 'LD_LIBRARY_PATH="$(~/"%STEAM_RUNTIME%" printenv LD_LIBRARY_PATH):./bin"');

// Adjust these values as needed to optimize catbot performance
// How long to wait for the TF2 process to be created by firejail
const TIMEOUT_START_GAME = 10000;
// Timeout for cathook to connect to the IPC server once injected
const TIMEOUT_IPC_STATE = 90000;
// Time to wait for steam to be "ready"
const TIMEOUT_STEAM_RUNNING = 60000;

const STATE = {
    INITIALIZING: 0,
    INITIALIZED: 1,
    STARTING: 3,
    WAITING: 4,
    RUNNING: 5,
    RESTARTING: 6,
    STOPPING: 7,
    WAITING_ACCOUNT: 8,
    INJECTED: 9
}

function makeid(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function clearSourceLockFiles() {
    var files = fs.readdirSync('/tmp/');
    files.forEach((str, index, arr) => {
        if (str.startsWith("source_engine") && str.endsWith(".lock"))
            fs.unlink(`/tmp/${str}`, (err) => {
                if (err)
                    console.log("[ERROR] Failed to delete a source engine lock!");
            });
    });
}

if (!process.env.SUDO_USER) {
    console.error('[ERROR] Could not find $SUDO_USER');
    process.exit(1);
}

const USER = { name: process.env.SUDO_USER, uid: Number.parseInt(child_process.execSync("id -u " + process.env.SUDO_USER).toString().trim()), home: child_process.execSync(`printf ~${process.env.SUDO_USER}`).toString(), interface: child_process.execSync("route -n | grep '^0\.0\.0\.0' | grep -o '[^ ]*$' | head -n 1").toString().trim(), SUPPORTS_FJ_NET: true };
try {
    child_process.execSync(`firejail --quiet --noprofile --net=${USER.interface} bash -c "ping -q -c 1 -W 1 1.1.1.1 >/dev/null && echo ok"`)
} catch (error) {
    USER.SUPPORTS_FJ_NET = false;
}

console.log('Main user name: ' + USER.name);

class Bot extends EventEmitter {
    constructor(botid) {
        super();
        var self = this;
        this.state = STATE.INITIALIZING;

        this.name = "b" + botid;
        this.botid = botid;
        this.home = path.join(__dirname, "..", "..", "user_instances", this.name)

        // Create a network namespace for this bot
        if (!USER.SUPPORTS_FJ_NET)
            child_process.execSync("./scripts/ns-inet " + this.botid)

        this.stopped = false;
        this.account = null;
        this.restarts = 0;

        this.log(`Initializing, folder = ${self.name}`);

        this.procFirejailSteam = null;
        this.procFirejailGame = null;

        // Start timestamp
        this.startTime = null;

        this.ipcState = null;
        this.ipcLastHeartbeat = 0;
        this.ipcID = -1;

        this.gameStarted = 0;

        this.logSteam = null;
        this.logGame = null;

        this.nativeSteam = fs.existsSync("/usr/bin/steam-native");

        this.spawnOptions = {
            shell: 'bash',
            uid: USER.uid,
            env: {
                HOME: USER.home
            }
        }

        this.on('ipc-data', function (obj) {
            if (self.state != STATE.RUNNING && self.state != STATE.WAITING)
                return;
            var id = obj.id;
            var data = obj.data;

            // There is no point in storing the same ipc data again. Removing this will actually cause IPC data to be set while the bot is not running.
            // This is only really a problem between tf2 crash/exit and IPC server auto removal
            if (data.heatbeat == self.ipcLastHeartbeat)
                return;
            self.ipcLastHeartbeat = data.heartbeat;

            self.ipcID = id;
            if (!self.ipcState) {
                self.log(`Assigned IPC ID ${id}`);
            }
            self.ipcState = data;
        });

        this.state = STATE.INITIALIZED;

        this.shouldRun = false;
        this.shouldRestart = false;
        this.isSteamWorking = false;
        this.time_steamWorking = 0;
        this.time_gameCheck = 0;
        this.time_ipcState = 0;
        this.gettingAccount = false;
    }

    log(message) {
        console.log(`[${timestamp('HH:mm:ss')}][${this.name}][${this.state}] ${message}`);
    }

    shouldSetupSteamapps() {
        try {
            return fs.existsSync(this.steamApps) && !fs.lstatSync(this.steamApps).isSymbolicLink();
        } catch (error) {
            return false;
        }
    }

    setupSteamapps() {
        // I'm scared of doing recursive deletes in nodejs
        fs.renameSync(this.steamApps, path.resolve(this.steamApps, '..', 'steamapps_old'));
        fs.symlinkSync("/opt/steamapps/", this.steamApps);
        return true;
    }

    spawnSteam() {
        var self = this;
        if (self.procFirejailSteam) {
            self.log('[ERROR] Steam is already running!');
            return;
        }

        if (!fs.existsSync(self.home)) {
            fs.mkdirSync(self.home);
            fs.chownSync(self.home, USER.uid, USER.uid);
        }

        /*if (!fs.existsSync(self.steamApps)) {
            fs.mkdirSync(path.join(self.steamApps, ".."), { recursive: true });
            fs.symlinkSync("/opt/steamapps/", self.steamApps);
            chownr.sync(self.steamPath, USER.uid, USER.uid);
        }*/
        var steambin = this.nativeSteam ? "steam-native" : "steam";

        self.procFirejailSteam = child_process.spawn(LAUNCH_OPTIONS_STEAM
            // Username
            .replace("%LOGIN%", self.account.login)
            // Password
            .replace("%PASSWORD%", self.account.password)
            // Name of the firejail jail
            .replace("%JAILNAME%", self.name)
            // LD_PRELOAD, "just disable vac"
            .replace("%LD_PRELOAD%", `"${process.env.STEAM_LD_PRELOAD}"`)
            // XOrg Display
            .replace("%DISPLAY%", process.env.DISPLAY)
            // Network
            .replace("%NETWORK%", USER.SUPPORTS_FJ_NET ? `--net=${USER.interface}` : `--dns=1.1.1.1 --netns=catbotns${this.botid}`)
            // Home folder
            .replace("%HOME%", self.home)
            .replace("%STEAM%", steambin),
            self.spawnOptions);
        self.logSteam = fs.createWriteStream('./logs/' + self.name + '.steam.log');
        self.logSteam.on('error', (err) => { self.log(`error on logSteam pipe: ${err}`) });
        self.procFirejailSteam.stdout.pipe(self.logSteam);
        self.procFirejailSteam.stderr.on("data", (data) => {
            var text = data.toString();
            if (text.includes("System startup time:")) {
                // Dynamically determine the corrrect paths, this supports debian, etc
                var steam_path = path.join(this.home, ".steam/steam");
                var steam_apps = path.join(steam_path, "steamapps");
                self.steamPath = path.resolve(this.home, path.relative(USER.home, fs.realpathSync(steam_path)));
                self.steamApps = path.resolve(this.home, path.relative(USER.home, fs.realpathSync(steam_apps)));
                self.tf2Path = path.join(this.steamApps, "common/Team Fortress 2");

                self.isSteamWorking = true;
                if (self.shouldSetupSteamapps()) {
                    self.setupSteamapps();
                }
            }
        });
        self.procFirejailSteam.stdout.on("data", (data) => {
            var text = data.toString();
            // Extend time if we are downloading updates.
            if (text.includes(" Downloading update (")) {
                self.time_steamWorking = Date.now() + TIMEOUT_STEAM_RUNNING;
            }
        });
        self.procFirejailSteam.stderr.pipe(self.logSteam);
        self.procFirejailSteam.on('exit', self.handleSteamExit.bind(self));
        self.log(`Launched ${steambin} (${self.procFirejailSteam.pid}) as ${self.account.steamID || self.account.steamid}`);
        self.emit('start-steam', self.procFirejailSteam.pid);
    }

    spawnGame() {
        var self = this;
        this.restarts++;

        var filename = `/tmp/.gl${makeid(6)}`;
        fs.copyFileSync("/opt/cathook/bin/libcathook-textmode.so", filename);

        clearSourceLockFiles();

        self.procFirejailGame = child_process.spawn((this.nativeSteam ? LAUNCH_OPTIONS_GAME_NATIVE : LAUNCH_OPTIONS_GAME_RUNTIME).replace("$GAMEPATH", path.relative(self.home, self.tf2Path).replace(/(\s+)/g, '\\$1'))
            // Firejail jail name used by this users steam
            .replace("%JAILNAME%", self.name)
            // Cathook
            .replace("%LD_PRELOAD%", `"${filename}:${process.env.STEAM_LD_PRELOAD}"`)
            // XORG display
            .replace("%DISPLAY%", process.env.DISPLAY)
            .replace("%STEAM_RUNTIME%", path.relative(self.home, path.join(self.steamPath, "/ubuntu12_32/steam-runtime/run.sh"))),
            [], self.spawnOptions);
        self.logGame = fs.createWriteStream('./logs/' + self.name + '.game.log');
        self.logGame.on('error', (err) => { self.log(`error on logGame pipe: ${err}`) });
        self.procFirejailGame.stdout.pipe(self.logGame);
        self.procFirejailGame.stderr.pipe(self.logGame);
        self.procFirejailGame.on('exit', self.handleGameExit.bind(self));

        setTimeout(function () {
            fs.unlinkSync(filename);
        }, TIMEOUT_START_GAME);
    }

    handleSteamExit(code, signal) {
        this.log(`Steam (${this.procFirejailSteam.pid}) exited with code ${code}, signal ${signal}`);
        this.emit('exit-steam');

        this.isSteamWorking = false;

        delete this.procFirejailSteam;
    }
    handleGameExit(code, signal) {
        this.log(`Game (${this.procFirejailGame.pid}) exited with code ${code}, signal ${signal}`);
        this.ipcState = null;
        delete this.procFirejailGame;
    }

    reset() {
        this.procFirejailSteam = null;
        this.procFirejailSteam = null;
        this.isSteamWorking = false;
        this.time_steamWorking = 0;
        this.time_gameCheck = 0;
        this.time_ipcState = 0;
        this.shouldRestart = false;
        this.gettingAccount = false;
        // Needs to be reset here because resetting it in handleGameExit is not enough
        this.ipcState = null;
    }

    killSteam() {
        this.log('Killing steam');
        // Firejail will handle smooth termination
        if (this.procFirejailSteam)
            this.procFirejailSteam.kill("SIGINT");
    }
    killGame() {
        this.log('Killing game');
        if (this.procFirejailGame)
            this.procFirejailGame.kill("SIGINT");
    }

    gameCheck() {
        try {
            var gamepid = Number.parseInt(child_process.execSync(`pgrep -P ${this.procFirejailGame.pid}`).toString().trim());

            var self = this;
            procfs(gamepid).stat(function (err, ret) {
                if (err) {
                    self.log("Error while getting stat.");
                } else {
                    self.startTime = ret.starttime;
                }
            })

            this.log(`Found game (${gamepid})`);
            this.emit('start-game', this.procFirejailGame.pid);
            clearSourceLockFiles();
        } catch (error) {
            this.log('[ERROR] Could not find running game!');
            return false;
        }
        return true;
    }

    // Apply current state
    update() {
        var time = Date.now();
        if (this.shouldRun && !this.shouldRestart) {
            if (this.procFirejailSteam) {
                if (!this.isSteamWorking) {
                    if (this.time_steamWorking && time > this.time_steamWorking) {
                        this.shouldRestart = true;
                        this.time_steamWorking = 0;
                    }
                    return;
                }
                else {
                    if (!this.procFirejailGame) {
                        this.spawnGame();
                        this.state = STATE.WAITING;
                        this.time_gameCheck = time + TIMEOUT_START_GAME;
                    }
                    else {
                        if (this.time_gameCheck) {
                            if (time > this.time_gameCheck) {
                                if (!this.gameCheck()) {
                                    this.shouldRestart = true;
                                    this.time_gameCheck = Number.MAX_SAFE_INTEGER;
                                }
                                else {
                                    this.time_gameCheck = 0;
                                    this.time_ipcState = time + TIMEOUT_IPC_STATE;
                                }
                            }
                        }
                        else {
                            if (this.ipcState) {
                                this.time_ipcState = 0;
                                this.state = STATE.RUNNING;
                                this.gameStarted = time;
                            } else if (this.time_ipcState && time > this.time_ipcState) {
                                this.killGame();
                                this.time_ipcState = 0;
                            }

                        }

                    }
                }
            }
            else {
                if (this.procFirejailGame) {
                    this.killGame();
                }
                else {
                    if (!this.account && !this.gettingAccount) {
                        this.gettingAccount = true;
                        this.state = STATE.WAITING_ACCOUNT;
                        this.log('Preparing to restart with new account...');
                        var self = this;
                        accounts.get(function (err, acc) {
                            if (err) {
                                self.log('Error while getting account!');
                                self.gettingAccount = false;
                                return;
                            }
                            self.account = acc;
                            // This also gets reset in this.reset, but just in case
                            self.gettingAccount = false;
                        });
                    }
                    else if (this.account) {
                        this.state = STATE.STARTING;
                        this.reset();
                        this.spawnSteam();
                        this.time_steamWorking = time + TIMEOUT_STEAM_RUNNING;
                    }
                }
            }
        }
        else {
            if (this.procFirejailGame) {
                this.killGame();
            }
            if (this.procFirejailSteam) {
                this.killSteam();
            }
            this.state = STATE.STOPPING;
            if (!this.procFirejailSteam && !this.procFirejailGame) {
                this.state = this.shouldRestart ? STATE.RESTARTING : STATE.INITIALIZED;
                this.shouldRestart = false;
            }
            if (!config.nodiscard && this.account) {
                this.log(`Discarding account ${this.account.login} (${this.account.steamID || this.account.steamid})`);
                this.account = null;
            }
        }
    }

    restart() {
        if (this.shouldRun)
            this.shouldRestart = true;
        else
            this.shouldRun = true;
    }
    stop() {
        this.shouldRun = false;
    }
    full_stop() {
        this.stop();
        // Delete the network namespace for this bot
        if (!USER.SUPPORTS_FJ_NET && fs.existsSync(`/var/run/netns/catbotns${this.botid}`))
            child_process.execSync(`./scripts/ns-delete ${this.botid}`)
        return !(this.procFirejailGame || this.procFirejailSteam)
    }
}

module.exports.bot = Bot;
module.exports.currentlyStartingGames = 0;
module.exports.states = STATE;
