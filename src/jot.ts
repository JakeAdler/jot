import readline from "node:readline";
import EventEmitter from "node:events";
import path from "node:path";
import fs from "node:fs";
import cp from "node:child_process";
import os from "node:os";
import process from "node:process";

// Types
interface Key {
    sequence: string;
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
}

interface Config {
    directory: string;
    tabstop: number;
    fillChar: string;
    commandTitle: string;
}

type EditorMode = "EDIT" | "COMMAND";

type num = number;
type str = string;

// Constants
const DEBUG = process.env.DEBUG;
const stdin = process.stdin;
const stdout = process.stdout;
const modeEmitter = new EventEmitter();

// State
let rows = stdout.rows;
let cols = stdout.columns;
let mode: EditorMode = "EDIT";
const lineBuf: string[][] = [[]];
const commandBuf = [];
let commandError = "";
let title = "";
const boundingBox = { x: 0, y: 1 };
const visible = { top: 0, bottom: rows };
const pos = { x: 0, y: 0 };
let tabstopStr = Array(4).fill("\t").join("");

// Config
let config: Config = {} as Config;

// Helpers
const ifEditMode = (cb: () => void) => () => mode === "EDIT" && cb();

const incX = ifEditMode(() => (pos.x += 1));

const decX = ifEditMode(() => pos.x !== 0 && (pos.x -= 1));

const incY = ifEditMode(() => {
    if (pos.y !== lineBuf.length - 1) pos.y += 1;
    if (pos.y > cols) {
        visible.top += 1;
        visible.bottom += 1;
    }
});

const decY = ifEditMode(() => {
    if (pos.y !== 0) pos.y -= 1;
    if (pos.y > cols) {
        visible.top -= 1;
        visible.bottom -= 1;
    }
});

const cursorTo = (x: num, y: num, cb?: () => any) => stdout.cursorTo(x, y, cb);

const isPrintable = (str: str) =>
    ["\\"].includes(str) || JSON.stringify(str).charAt(1) !== "\\";

const debug = (...messages: any[]) => DEBUG && console.log(...messages);

const clearCommandBuf = () => commandBuf.splice(0, commandBuf.length);

const getAllTitles = () => fs.readdirSync(config.directory);

const encodeTabs = (line: str) =>
    line
        .split("")
        .map((c) => (c === "\t" ? tabstopStr : c))
        .join("");

const decodeTabs = (line: str[]) =>
    line.join("").replace(tabstopStr, "\t").split("");

// Terminal
const handleExit = () => {
    stdout.write("\x1Bc");

    let file = "";

    for (let i = 0; i < lineBuf.length; i++) {
        const lineStr = decodeTabs(lineBuf[i]).join("");
        const suffix = i === lineBuf.length - 1 ? "" : "\n";

        debug(i, lineBuf[i]);

        file = file + lineStr + suffix;
    }

    if (file.trim().length) {
        fs.writeFileSync(path.join(config.directory, title), file, "utf-8");
    }

    debug("----\n", file);
    process.exit(0);
};

const renderTitle = (cb?: () => void) => {
    cursorTo(0, 0, () => {
        stdout.clearLine(1, () => {
            stdout.write(`\x1b[4m\x1b[1m${title}\x1b[0m`, () => {
                if (cb) cb();
            });
        });
    });
};

const renderEditMode = (next?: () => void) => {
    const transformChars = (char: str) => {
        if (char === "\t") return " ";
        return char;
    };
    const renderLines = () => {
        for (
            let i = visible.top;
            i < (pos.y > cols ? visible.bottom : lineBuf.length); // Vertical scrolling
            i++
        ) {
            let line = lineBuf[i].map(transformChars).join("");
            let suffix = "\n";
            if (i === lineBuf.length - 1) {
                suffix = "";
            }

            // horizontal scrolling
            if (pos.x >= cols) {
                line = line.slice(pos.x - cols + 1, pos.x);
            } else {
                line = line.slice(0, cols);
            }

            stdout.write(line + suffix);
        }

        const positionCursor = () => {
            let x = pos.x + boundingBox.x;
            let y = pos.y;
            if (pos.y < rows) y = y + boundingBox.y;
            cursorTo(x, y, () => {
                if (next) next();
            });
        };

        if (lineBuf.length < rows && pos.x < cols) {
            cursorTo(0, lineBuf.length - 1 + boundingBox.y, () => {
                for (let i = 0; i < rows - lineBuf.length - 1; i++) {
                    stdout.write(`\n${config.fillChar}`);
                }
                positionCursor();
            });
        } else {
            positionCursor();
        }
    };

    renderTitle(() => {
        cursorTo(0, boundingBox.y, () => {
            stdout.clearScreenDown(renderLines);
        });
    });
};

const renderCommandMode = (outChar: string) => {
    if (outChar) {
        commandBuf.push(outChar);
    }
    renderEditMode(() => {
        cursorTo(0, rows, () => {
            stdout.clearLine(0, () => {
                const write = (s: str) => stdout.write(config.commandTitle + s);
                if (commandError) {
                    write(commandError);
                    commandError = "";
                    clearCommandBuf();
                } else if (commandBuf) {
                    write(commandBuf.join(""));
                }
            });
        });
    });
};

const handleKeyPress = (_: any, key: Key) => {
    let outChar = isPrintable(key.sequence) ? key.sequence : undefined;

    if (mode === "EDIT") {
        switch (key.name) {
            case "return":
            case "enter":
                outChar = undefined;
                if (pos.y === lineBuf.length - 1) {
                    lineBuf.push([]);
                } else {
                    lineBuf.splice(pos.y + 1, 0, lineBuf[pos.y].slice(pos.x));
                    lineBuf[pos.y] = lineBuf[pos.y].slice(0, pos.x);
                }
                incY();
                if (lineBuf[pos.y]) pos.x = lineBuf[pos.y].length;
                break;
            case "backspace":
                outChar = undefined;
                if (lineBuf[pos.y].length) {
                    if (pos.x === 0) {
                        lineBuf[pos.y - 1].push(...lineBuf[pos.y]);
                        const [deletedLine] = lineBuf.splice(pos.y);
                        decY();
                        pos.x = lineBuf[pos.y].length - deletedLine.length;
                    } else {
                        decX();
                        const [deleted] = lineBuf[pos.y].splice(pos.x, 1);
                        if (deleted === "\t") {
                            for (let i = 0; i < config.tabstop - 1; i++) decX();
                            lineBuf[pos.y].splice(pos.x, config.tabstop - 1);
                        }
                    }
                } else if (lineBuf[pos.y - 1]) {
                    if (!lineBuf[pos.y].length) lineBuf.splice(pos.y, 1);
                    decY();
                    pos.x = lineBuf[pos.y].length;
                }
                break;
            case "tab":
                for (let i = 0; i < config.tabstop; i++) incX();
                outChar = tabstopStr;
                break;
            case "c":
                if (key.ctrl) {
                    mode = "COMMAND";
                    modeEmitter.emit("change");
                    return;
                } else {
                    incX();
                }
                break;
            case "x":
                if (key.ctrl) {
                    handleExit();
                } else {
                    incX();
                }
                break;
            case "up":
                decY();
                pos.x = lineBuf[pos.y].length;
                break;
            case "down":
                incY();
                if (lineBuf[pos.y]) pos.x = lineBuf[pos.y].length;
                break;
            case "left":
                decX();
                break;
            case "right":
                if (pos.x !== lineBuf[pos.y].length) incX();
                break;
            default:
                if (outChar) {
                    for (let i = 0; i < outChar.length; i++) incX();
                }
                break;
        }

        if (outChar) {
            lineBuf[pos.y].splice(pos.x - 1, 0, ...outChar); // Spread for tabstr and other long strings (none i can think of)
        }

        renderEditMode();
    } else if (mode === "COMMAND") {
        switch (key.name) {
            case "return":
                const commandRegex = {
                    quit: /\bq\b|\bquit/gm,
                    title: /^t\s.*?|\bt\b|^(\btitle\b.\s?).*?/gm,
                    delete: /^\bdelete\b$/gm,
                    help: /^\bhelp\b$/gm,
                };

                const cmd = commandBuf.join("");

                switch (true) {
                    case commandRegex.quit.test(cmd):
                        handleExit();
                        break;
                    case commandRegex.title.test(cmd):
                        const args = cmd.split(" ");
                        args.shift();
                        if (!args.length) {
                            commandError = "title command requires 1 argument";
                        } else {
                            const proposedTitle = args.join(" ");
                            if (getAllTitles().includes(proposedTitle)) {
                                commandError = `Title '${proposedTitle}' already exists.`;
                            } else {
                                if (
                                    fs.existsSync(
                                        path.join(config.directory, title)
                                    )
                                ) {
                                    fs.renameSync(
                                        path.join(config.directory, title),
                                        path.join(
                                            config.directory,
                                            proposedTitle
                                        )
                                    );
                                }
                                title = proposedTitle;
                            }

                            clearCommandBuf();
                        }
                        break;
                    case commandRegex.delete.test(cmd):
                        fs.unlinkSync(path.join(config.directory, title));
                        stdout.write("\x1Bc");
                        console.log(`Deleted '${title}'`);
                        process.exit(0);
                    case commandRegex.help.test(cmd):
                        // This is a dirty hack to display a temp message
                        commandError = `

=================
Command Mode Help

Commands    Description
quit | q    Saves and quits.
title | t   Set the title. 
delete      Deletes (permanantly).
=================

`;
                        break;
                    default:
                        clearCommandBuf();
                        if (cmd) commandError = "Unknown command";
                        break;
                }
                break;
            case "backspace":
                outChar = undefined;
                commandBuf.pop();
                break;
            case "c":
                if (key.ctrl) {
                    mode = "EDIT";
                    modeEmitter.emit("change");
                    return;
                }
                break;
        }

        renderCommandMode(outChar);
    }
};

// Program

const getPlatformPath = (type: "config" | "data") => {
    const home = os.homedir();
    const { env } = process;
    if (process.platform === "darwin") {
        const macosLib = path.join(home, "Library");
        if (type === "config") return path.join(macosLib, "Preferences", "jot");
        if (type === "data")
            return path.join(macosLib, "Application Support", "jot");
    }

    if (process.platform === "win32") {
        const winAppData = env.APPDATA || path.join(home, "AppData", "Roaming");
        const winLocalAppData =
            env.LOCALAPPDATA || path.join(home, "AppData", "Local");

        if (type === "config") return path.join(winAppData, "jot", "Config");
        if (type === "data") return path.join(winLocalAppData, "jot", "Data");
    }

    if (type === "config")
        return path.join(
            env.XDG_CONFIG_HOME || path.join(home, ".config"),
            "jot"
        );
    if (type === "data")
        return path.join(
            env.XDG_DATA_HOME || path.join(home, ".local/share"),
            "jot"
        );
};

const loadFile = (name: string) => {
    const exists = fs.existsSync(path.join(config.directory, name));
    title = name;
    if (exists) {
        const fileBuf = fs.readFileSync(path.join(config.directory, name));
        const fileStr = fileBuf.toString("utf-8");
        const fileLines = fileStr.split("\n").map(encodeTabs);
        const fileLinesSplit = fileLines.map((line) => line.split(""));
        lineBuf.splice(0, 1);
        lineBuf.push(...fileLinesSplit);
        pos.x = lineBuf[0].length;
    }
};

const handleCliArguments = (args: string[], flag: string | undefined) => {
    const noArgs = () => {
        if (args.length) {
            console.log(`Flag -${flag} does not support arguments.`);
            process.exit(0);
        }
    };

    let fileToLoad = args.join(" ");
    if (flag) {
        flag = flag.slice(1);
        switch (flag) {
            case "f":
                noArgs();
                if (!getAllTitles().length) {
                    console.log("No jots. Run `jot [TITLE]` to create a jot.");
                    process.exit(0);
                }
                const proc = cp.spawnSync("fzf", ["--preview", "cat {}"], {
                    stdio: [process.stdin, null, process.stderr],
                    cwd: config.directory,
                    encoding: "utf-8",
                });

                if (proc.error) {
                    console.log("Error spawning fzf. Ensure fzf is installed.");
                    process.exit(1);
                }

                if (proc.status === 0) {
                    fileToLoad = proc.stdout.trim();
                } else {
                    process.exit(proc.status);
                }
                break;
            case "l":
                noArgs();
                //TODO: handle list
                const titles = getAllTitles();
                for (const title of titles) {
                    console.log(title);
                }
                if (!titles.length)
                    console.log("No jots. Run `jot [TITLE]` to create a jot.");
                process.exit(0);
            case "h":
                noArgs();
                console.log(`jot

jot [title]     Create/open a jot
-d  [title]     Delete jot
-f              Find and open a jot using fzf
-h              Print help message
-l              List jots
                        `);
                process.exit(0);
            case "d":
                if (fileToLoad) {
                    if (
                        fs.existsSync(path.join(config.directory, fileToLoad))
                    ) {
                        fs.unlinkSync(path.join(config.directory, fileToLoad));
                        console.log(`Deleted '${fileToLoad}'`);
                    } else {
                        console.log(
                            `Jot with name '${fileToLoad}' does not exist`
                        );
                    }
                } else {
                    console.log("-d flag requires a title as an argument");
                }
                process.exit(0);
            default:
                console.log("Unkown flag -" + flag);
                process.exit(1);
        }
    }

    const defaultFileName =
        new Date().toDateString() + " " + new Date().toLocaleTimeString();
    loadFile(fileToLoad || defaultFileName);
};

const loadConfig = () => {
    const confPath = path.join(getPlatformPath("config"), "config.json");

    if (!fs.existsSync(confPath)) {
        createConfig();
    }

    try {
        const configFile = fs.readFileSync(confPath, "utf-8");
        try {
            config = JSON.parse(configFile);

            tabstopStr = Array(config.tabstop).fill("\t").join("");
        } catch (err) {
            console.log("Error parsing config file.");
            process.exit(1);
        }
    } catch (e) {
        console.log("Error reading config file.");
        process.exit(1);
    }

    const directoryExists = fs.existsSync(config.directory);

    if (!directoryExists) {
        try {
            fs.mkdirSync(path.resolve(config.directory));
        } catch (e) {
            console.log("Error creating data directory.");
            process.exit(1);
        }
    }
};

const createConfig = () => {
    const confDir = getPlatformPath("config");
    const confPath = path.join(confDir, "config.json");

    const defaultConfig = JSON.stringify(
        {
            directory: getPlatformPath("data"),
            tabstop: 4,
            fillChar: "~",
            commandTitle: "CMD: ",
        },
        null,
        2
    );

    if (!fs.existsSync(confDir)) {
        fs.mkdirSync(confDir, { recursive: true });
    }

    if (!fs.existsSync(confPath)) {
        fs.writeFileSync(confPath, defaultConfig, { encoding: "utf-8" });
    }
};

// Init

const initTerminal = async () => {
    let queue = [];

    stdin.setRawMode(true);

    readline.emitKeypressEvents(stdin);

    stdin.on("keypress", (chunk: never, key) => queue.push([chunk, key]));

    modeEmitter.on("change", () => {
        if (mode === "COMMAND") {
            renderCommandMode("");
        }

        if (mode === "EDIT") {
            renderEditMode();
        }
    });

    cursorTo(0, 0, () => {
        stdout.clearScreenDown(() => {
            renderTitle(() => {
                renderEditMode();
            });
        });
    });

    const sleep = () => new Promise((r) => setImmediate(() => r(null)));
    while (true) {
        // Non blocking infinite loop
        await sleep();
        if (queue.length) {
            const [chunk, key] = queue.shift();
            handleKeyPress(chunk, key);
        }
    }
};

const initProgram = async () => {
    loadConfig();

    const argv = process.argv.slice(2);

    const flags = argv.filter((a) => a.startsWith("-"));
    const args = argv.filter((a) => !a.startsWith("-"));

    if (flags.length > 1) {
        console.log("Too many flags passed.");
        process.exit(1);
    }

    handleCliArguments(args, flags[0]);

    initTerminal();
};

initProgram();
