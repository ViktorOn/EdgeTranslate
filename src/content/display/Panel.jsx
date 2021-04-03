/** @jsx h */
import { h } from "preact";
import { useEffect, useState, useRef, useCallback, useReducer } from "preact/hooks";
import { useLatest, useEvent, useClickAway } from "react-use";
import root from "react-shadow/styled-components";
import Messager from "common/scripts/messager.js";
import Notifier from "./library/notifier/notifier.js";
import moveable from "./library/moveable/moveable.js";
import { delayPromise } from "common/scripts/promise.js";
import { isChromePDFViewer } from "../common.js";
import Result from "./Result.jsx"; // display translate result
import Loading from "./Loading.jsx"; // display loading animation
import Error from "./Error.jsx"; // display error messages
import SettingIcon from "./icons/setting.svg";
import PinIcon from "./icons/pin.svg";
import UnpinIcon from "./icons/unpin.svg";
import CloseIcon from "./icons/close.svg";

export const CommonPrefix = "edge-translate-";
const notifier = new Notifier("center");
// Store the translation result and attach it to window
window.translateResult = {};
// Flag of showing result.
window.isDisplayingResult = false;
// store the width of scroll bar
const scrollbarWidth = getScrollbarWidth();
// store original css text on document.body
let documentBodyCSS = "";
// the duration time of result panel's transition. unit: ms
const transitionDuration = 500;
// TTS speeds
let sourceTTSSpeed = "fast",
    targetTTSSpeed = "fast";

export default function Panel() {
    // whether the result is open
    const [open, setOpen] = useState(false);
    // whether the panel is fixed(the panel won't be close when users click outside of the it)
    const [panelFix, setPanelFix] = useState();
    // "LOADING" | "RESULT" | "ERROR"
    const [contentType, setContentType] = useState("LOADING");
    // translate results or error messages
    const [content, setContent] = useState({});
    // refer to the latest content equivalent to useRef()
    const contentRef = useLatest(content);
    // available translators for current language setting
    const [availableTranslators, setAvailableTranslators] = useState();
    // selected translator
    const [currentTranslator, setCurrentTranslator] = useState();
    // control the behavior of highlight part
    const [highlight, setHighlight] = useState({
        show: false, // whether to show the highlight part
        position: "right", // the position of the highlight part. value: "left"|"right"
    });
    /**
     * the pronounce status
     * These states should belong to Result.jsx but because Panel is in charge of receiving pronounce messages, it's more convenient to share pronounce states in this way.
     */
    const [sourcePronouncing, setSourcePronounce] = useReducer(sourcePronounce, false),
        [targetPronouncing, setTargetPronounce] = useReducer(targetPronounce, false);
    const containerElRef = useRef(), // the container of translation panel.
        panelElRef = useRef(), // panel element
        headElRef = useRef(), // panel head element
        bodyElRef = useRef(); // panel body element
    // store the moveable object return by moveable.js
    const moveablePanelRef = useRef(null);
    // store the display type(floating or fixed)
    const displaySettingRef = useRef({
        type: "fixed",
        fixedData: {
            width: 0.2,
            position: "right",
        },
        floatingData: {
            width: 0.15,
            height: 0.6,
        },
    });
    // flag whether the user set to resize document body when panel is resized in fixed display mode
    const resizePageFlag = useRef(false);

    /**
     * update the bounds value for draggable area
     */
    const updateBounds = useCallback(async () => {
        // if the panel is open
        if (containerElRef.current) {
            await getDisplaySetting();
            let scrollLeft = document.documentElement.scrollLeft || document.body.scrollLeft;
            let scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
            moveablePanelRef.current?.setBounds({
                left: scrollLeft,
                top: scrollTop,
                right: scrollLeft + window.innerWidth - (hasScrollbar() ? scrollbarWidth : 0),
                bottom:
                    scrollTop +
                    (1 + displaySettingRef.current.floatingData.height) * window.innerHeight -
                    64,
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * the handler for window resize event
     * update drag bounds and the size or position of the result panel
     */
    const windowResizeHandler = useCallback(() => {
        updateBounds();
        // if result panel is open
        if (panelElRef.current) {
            if (displaySettingRef.current.type === "fixed") showFixedPanel();
            else
                moveablePanelRef.current.request("resizable", {
                    width: displaySettingRef.current.floatingData.width * window.innerWidth,
                    height: displaySettingRef.current.floatingData.height * window.innerHeight,
                });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* do some initialization stuff */
    useEffect(() => {
        getDisplaySetting();

        chrome.storage.sync.get(["languageSetting", "DefaultTranslator"], async (result) => {
            let languageSetting = result.languageSetting;
            let availableTranslators = await Messager.send(
                "background",
                "get_available_translators",
                {
                    from: languageSetting.sl,
                    to: languageSetting.tl,
                }
            );
            setAvailableTranslators(availableTranslators);
            setCurrentTranslator(result.DefaultTranslator);
        });

        chrome.storage.sync.get("fixSetting", (result) => {
            setPanelFix(result.fixSetting);
        });

        /**
         * process messages sent from background.js
         *
         * @param {Object} message the message sent from background.js
         * @param {Object} sender the detailed message of message sender. If the sender is content module, it'll includes the tab property. If the sender is background, the tab property isn't contained.
         */
        Messager.receive("content", (message) => {
            /**
             * Check message timestamp.
             *
             * translateResult keeps the latest(biggest) timestamp ever received.
             */
            if (window.translateResult.timestamp && message.detail.timestamp) {
                /**
                 * When a new message with timestamp arrived, we check if the timestamp stored in translateResult
                 * is bigger than the timestamp of the arriving message.
                 */
                if (window.translateResult.timestamp > message.detail.timestamp) {
                    /**
                     * If it does, which means the corresponding translating request is out of date, we drop the
                     * message.
                     */
                    return Promise.resolve();
                }
                /**
                 * If it doesn't, which means the corresponding translating request is up to date, we update
                 * the timestamp stored in translateResult and accept the message.
                 */
                window.translateResult.timestamp = message.detail.timestamp;
            }

            switch (message.title) {
                case "before_translating":
                    // the translator send this message to make sure current tab can display result panel
                    break;
                case "start_translating":
                    // Remember translating text.
                    window.translateResult.originalText = message.detail.text;
                    setOpen(true);
                    setContentType("LOADING");
                    setContent(message.detail);
                    break;
                case "translating_finished":
                    window.translateResult = message.detail;
                    sourceTTSSpeed = "fast";
                    targetTTSSpeed = "fast";
                    setOpen(true);
                    setContentType("RESULT");
                    setContent(message.detail);
                    break;
                case "translating_error":
                    setContentType("ERROR");
                    setContent(message.detail);
                    break;
                case "pronouncing_finished":
                    if (message.detail.pronouncing === "source") setSourcePronounce(false);
                    else if (message.detail.pronouncing === "target") setTargetPronounce(false);
                    break;
                case "pronouncing_error":
                    if (message.detail.pronouncing === "source") setSourcePronounce(false);
                    else if (message.detail.pronouncing === "target") setTargetPronounce(false);
                    notifier.notify({
                        type: "error",
                        title: chrome.i18n.getMessage("AppName"),
                        detail: chrome.i18n.getMessage("PRONOUN_ERR"),
                    });
                    break;
                case "update_translator_options":
                    setAvailableTranslators(message.detail.availableTranslators);
                    setCurrentTranslator(message.detail.selectedTranslator);
                    break;
                // shortcut command
                case "command":
                    switch (message.detail.command) {
                        case "fix_result_frame":
                            chrome.storage.sync.get("fixSetting", (result) => {
                                setPanelFix(result.fixSetting);
                            });
                            break;
                        case "close_result_frame":
                            setOpen(false);
                            break;
                        case "pronounce_original":
                            setSourcePronounce(true);
                            break;
                        case "pronounce_translated":
                            setTargetPronounce(true);
                            break;
                        case "copy_result":
                            if (window.translateResult.mainMeaning) {
                                copyContent();
                            }
                            break;
                        default:
                            break;
                    }
                    break;
                default:
                    break;
            }
            return Promise.resolve();
        });
    }, []);

    /**
     * when status of result panel is changed(open or close), this function will be triggered
     */
    const onDisplayStatusChange = useCallback((containerEl) => {
        panelElRef.current = containerEl;

        /* if panel is closed */
        if (!containerEl) {
            // clear the outdated moveable object
            moveablePanelRef.current = null;

            // Tell select.js that the result panel has been removed.
            window.isDisplayingResult = false;

            removeFixedPanel();

            // Handle the click event exception when using chrome's original pdf viewer
            if (isChromePDFViewer()) {
                document.body.children[0].focus();
            }

            setSourcePronounce(false);
            setTargetPronounce(false);

            // Tell background.js that the result panel has been closed
            Messager.send("background", "frame_closed");
            return;
        }

        /* else if panel is open */
        // Tell select.js that we are displaying results.
        window.isDisplayingResult = true;

        /* make the resultPanel resizable and draggable */
        moveablePanelRef.current = new moveable(containerEl, {
            draggable: true,
            resizable: true,
            /* set threshold value to increase the resize area */
            // threshold: { s: 5, se: 5, e: 5, ne: 5, n: 5, nw: 5, w: 5, sw: 5 },
            // threshold: { edge:5, corner:5 },
            threshold: 5,
            /**
             * set thresholdPosition to decide where the resizable area is
             * "in": the activated resizable area is within the target element
             * "center": the activated resizable area is half within the target element and half out of the it
             * "out": the activated resizable area is out of the target element
             * a number(0~1): a ratio which determines the how much the the activated resizable area beyond the element
             */
            // thresholdPosition: "in",
            // thresholdPosition: "center",
            // thresholdPosition: "out",
            thresholdPosition: 0.7,
            minWidth: 100,
            minHeight: 150,
        });

        let startTranslate = [0, 0];
        // to flag whether the floating panel should be changed to fixed panel
        let floatingToFixed = false;
        // store the fixed direction on bound event
        let fixedDirection = "";
        /* draggable events*/
        moveablePanelRef.current
            .on("dragStart", ({ set, stop, inputEvent }) => {
                if (inputEvent) {
                    const path =
                        inputEvent.path || (inputEvent.composedPath && inputEvent.composedPath());
                    // if drag element isn't the head element, stop the drag event
                    if (!path || !headElRef.current?.isSameNode(path[0])) {
                        stop();
                        return;
                    }
                }
                set(startTranslate);
            })
            .on("drag", ({ target, translate }) => {
                startTranslate = translate;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;
            })
            .on("dragEnd", ({ translate, inputEvent }) => {
                startTranslate = translate;

                /* change the display type of result panel */
                if (inputEvent && displaySettingRef.current.type === "floating") {
                    if (floatingToFixed) {
                        displaySettingRef.current.fixedData.position = fixedDirection;
                        displaySettingRef.current.type = "fixed";
                        // remove the highlight part
                        setHighlight({
                            show: false,
                            position: "right",
                        });
                        showFixedPanel();
                        updateDisplaySetting();
                    }
                }
            })
            // // the result panel start to drag out of the drag area
            // .on("boundStart", ({ direction }) => {
            //     console.log(direction);
            // })
            // the result panel drag out of the drag area
            .on("bound", ({ direction, distance }) => {
                /* whether to show hight part on the one side of the page*/
                if (displaySettingRef.current.type === "floating") {
                    let threshold = 10;
                    if (distance > threshold) {
                        if (direction === "left" || direction === "right") {
                            fixedDirection = direction;
                            floatingToFixed = true;
                            // show highlight part
                            setHighlight({
                                show: true,
                                position: direction,
                            });
                        }
                    }
                }
            })
            // the result panel drag into drag area first time
            .on("boundEnd", () => {
                if (floatingToFixed)
                    // remove the highlight part
                    setHighlight({
                        show: false,
                        position: "right",
                    });
                floatingToFixed = false;
                // change the display type from fixed to floating
                if (displaySettingRef.current.type === "fixed") {
                    displaySettingRef.current.type = "floating";
                    removeFixedPanel();
                    showFloatingPanel();
                    updateDisplaySetting();
                }
            });
        /* listen to resizable  events */
        moveablePanelRef.current
            .on("resizeStart", ({ set }) => {
                set(startTranslate);
            })
            .on("resize", ({ target, width, height, translate, inputEvent }) => {
                target.style.width = `${width}px`;
                target.style.height = `${height}px`;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;
                if (inputEvent) {
                    if (displaySettingRef.current.type === "fixed" && resizePageFlag.current) {
                        document.body.style.width = `${(1 - width / window.innerWidth) * 100}%`;
                    }
                }
            })
            .on("resizeEnd", ({ translate, width, height, inputEvent, target }) => {
                startTranslate = translate;
                target.style.transform = `translate(${translate[0]}px, ${translate[1]}px)`;

                // update new size of the result panel
                if (inputEvent) {
                    if (displaySettingRef.current.type === "floating") {
                        displaySettingRef.current.floatingData.width = width / window.innerWidth;
                        displaySettingRef.current.floatingData.height = height / window.innerHeight;
                    } else {
                        displaySettingRef.current.fixedData.width = width / window.innerWidth;
                    }
                    updateDisplaySetting();
                }
            });
        showPanel();
    }, []);

    /* called when user translate another time */
    useEffect(() => {
        // if panel is open and the panel position is updated
        if (panelElRef.current && content.position) {
            showPanel();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content.position]);

    // update drag bounds when users scroll the page
    useEvent("scroll", updateBounds, window);

    // update the drag bounds and size when the size of window has changed
    useEvent("resize", windowResizeHandler, window);

    useClickAway(containerElRef, () => {
        // the panel will be closed if users click outside of the it with the panelFix option closed
        if (!panelFix) {
            setOpen(false);
        }
    });

    /**
     * display the panel
     */
    async function showPanel() {
        await getDisplaySetting();
        updateBounds();
        if (displaySettingRef.current.type === "floating") {
            /* show floating panel */
            let position;
            let width = displaySettingRef.current.floatingData.width * window.innerWidth;
            let height = displaySettingRef.current.floatingData.height * window.innerHeight;
            if (contentRef.current.position) {
                /* adjust the position of result panel. Avoid to beyond the range of page */
                const XBias = 20,
                    YBias = 20,
                    threshold = height / 4;
                position = [contentRef.current.position[0], contentRef.current.position[1]];
                // the result panel would exceeds the right boundary of the page
                if (position[0] + width > window.innerWidth) {
                    position[0] = position[0] - width - XBias;
                }
                // the result panel would exceeds the bottom boundary of the page
                if (position[1] + height > window.innerHeight + threshold) {
                    // make true the panel wouldn't exceed the top boundary
                    let newPosition1 = position[1] - height - YBias + threshold;
                    position[1] = newPosition1 < 0 ? 0 : newPosition1;
                }
                position = [position[0] + XBias, position[1] + YBias];
            } else
                position = [
                    (1 - displaySettingRef.current.floatingData.width) * window.innerWidth -
                        (hasScrollbar() ? scrollbarWidth : 0),
                    0,
                ];
            showFloatingPanel();
            moveablePanelRef.current.request("draggable", { x: position[0], y: position[1] });
        } else {
            showFixedPanel();
        }
    }

    /**
     * show the result panel in the floating type
     */
    function showFloatingPanel() {
        /* set border radius for the floating type result panel */
        headElRef.current.style["border-radius"] = "6px 6px 0 0";
        bodyElRef.current.style["border-radius"] = "0 0 6px 6px";
        moveablePanelRef.current.request("resizable", {
            width: displaySettingRef.current.floatingData.width * window.innerWidth,
            height: displaySettingRef.current.floatingData.height * window.innerHeight,
        });
    }

    /**
     * show the result panel in the fixed type
     */
    function showFixedPanel() {
        let width = displaySettingRef.current.fixedData.width * window.innerWidth;
        // the offset left value for fixed result panel
        let offsetLeft = 0;
        if (displaySettingRef.current.fixedData.position === "right")
            offsetLeft = window.innerWidth - width - (hasScrollbar() ? scrollbarWidth : 0);
        chrome.storage.sync.get("LayoutSettings", async (result) => {
            resizePageFlag.current = result.LayoutSettings.Resize;
            // user set to resize the document body
            if (resizePageFlag.current) {
                // store the original css text. when fixed panel is removed, restore the style of document.body
                documentBodyCSS = document.body.style.cssText;

                document.body.style.position = "absolute";
                document.body.style.transition = `width ${transitionDuration}ms`;
                panelElRef.current.style.transition = `width ${transitionDuration}ms`;
                /* set the start width to make the transition effect work */
                document.body.style.width = "100%";
                move(0, window.innerHeight, offsetLeft, 0);
                // wait some time to make the setting of width applied
                await delayPromise(50);
                // the fixed panel in on the left side
                if (displaySettingRef.current.fixedData.position === "left") {
                    document.body.style.right = "0";
                    document.body.style.left = "";
                }
                // the fixed panel in on the right side
                else {
                    document.body.style.margin = "0";
                    document.body.style.right = "";
                    document.body.style.left = "0";
                }
                // set the target width for document body
                document.body.style.width = `${
                    (1 - displaySettingRef.current.fixedData.width) * 100
                }%`;
                // set the target width for the result panel
                move(width, window.innerHeight, offsetLeft, 0);
                /* cancel the transition effect after the panel showed */
                await delayPromise(transitionDuration);
                panelElRef.current.style.transition = "";
                document.body.style.transition = "";
            } else move(width, window.innerHeight, offsetLeft, 0);
        });

        /* cancel the border radius of the fixed type result panel */
        headElRef.current.style["border-radius"] = "";
        bodyElRef.current.style["border-radius"] = "";
    }

    /**
     * if user choose to resize the document body, make the page return to normal size
     */
    async function removeFixedPanel() {
        if (resizePageFlag.current) {
            document.body.style.transition = `width ${transitionDuration}ms`;
            await delayPromise(50);
            document.body.style.width = "100%";
            await delayPromise(transitionDuration);
            document.body.style.cssText = documentBodyCSS;
        }
    }

    /**
     * drag the target element to a specified position and resize it to a specific size
     * @param {number} width width
     * @param {number} height height value
     * @param {number} left x-axis coordinate of the target position
     * @param {number} top y-axis coordinate of the target position
     */
    function move(width, height, left, top) {
        moveablePanelRef.current.request("draggable", {
            x: left,
            y: top,
        });
        moveablePanelRef.current.request("resizable", {
            width,
            height,
        });
    }

    /**
     * get the display setting in chrome.storage api
     * @returns {Promise{undefined}} null promise
     */
    function getDisplaySetting() {
        return new Promise((resolve) => {
            chrome.storage.sync.get("DisplaySetting", (result) => {
                if (result.DisplaySetting) {
                    displaySettingRef.current = result.DisplaySetting;
                } else {
                    updateDisplaySetting();
                }
                resolve();
            });
        });
    }

    /**
     * update the display setting in chrome.storage
     */
    function updateDisplaySetting() {
        chrome.storage.sync.set({ DisplaySetting: displaySettingRef.current });
    }

    return (
        open && (
            <root.div id={`${CommonPrefix}container`} ref={containerElRef}>
                <div
                    id={`${CommonPrefix}panel`}
                    style="position: fixed;"
                    ref={onDisplayStatusChange}
                >
                    <link
                        type="text/css"
                        rel="stylesheet"
                        href={chrome.runtime.getURL("content/display/style/display.css")}
                    />
                    <div id={`${CommonPrefix}head`} ref={headElRef}>
                        <div id={`${CommonPrefix}head-icons`}>
                            <div
                                class={`${CommonPrefix}head-icon`}
                                id={`${CommonPrefix}icon-options`}
                                onClick={() => Messager.send("background", "open_options_page", {})}
                            >
                                <SettingIcon />
                            </div>
                            {panelFix ? (
                                <div
                                    class={`${CommonPrefix}head-icon`}
                                    id={`${CommonPrefix}icon-pin`}
                                    onClick={() => {
                                        setPanelFix(false);
                                        chrome.storage.sync.set({
                                            fixSetting: false,
                                        });
                                    }}
                                >
                                    <PinIcon />
                                </div>
                            ) : (
                                <div
                                    class={`${CommonPrefix}head-icon`}
                                    id={`${CommonPrefix}icon-unpin`}
                                    onClick={() => {
                                        setPanelFix(true);
                                        chrome.storage.sync.set({
                                            fixSetting: true,
                                        });
                                    }}
                                >
                                    <UnpinIcon />
                                </div>
                            )}
                            <div
                                class={`${CommonPrefix}head-icon`}
                                id={`${CommonPrefix}icon-close`}
                                onClick={() => setOpen(false)}
                            >
                                <CloseIcon />
                            </div>
                        </div>
                    </div>
                    <div id={`${CommonPrefix}source-option`}>
                        <span>正在使用</span>
                        <select
                            name="translators"
                            id={`${CommonPrefix}translators`}
                            value={currentTranslator}
                            onChange={(event) => {
                                const newTranslator = event.target.value;
                                setCurrentTranslator(newTranslator);
                                Messager.send("background", "update_default_translator", {
                                    translator: newTranslator,
                                }).then(() => {
                                    if (window.translateResult.originalText)
                                        Messager.send("background", "translate", {
                                            text: window.translateResult.originalText,
                                        });
                                });
                            }}
                        >
                            {availableTranslators.map((translator) => (
                                <option key={translator} value={translator}>
                                    {chrome.i18n.getMessage(translator)}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div id={`${CommonPrefix}body`} ref={bodyElRef}>
                        {contentType === "LOADING" && <Loading />}
                        {contentType === "RESULT" && (
                            <Result
                                {...content}
                                sourcePronouncing={sourcePronouncing}
                                targetPronouncing={targetPronouncing}
                                setSourcePronounce={setSourcePronounce}
                                setTargetPronounce={setTargetPronounce}
                            />
                        )}
                        {contentType === "ERROR" && <Error {...content} />}
                    </div>
                </div>
                {highlight.show && (
                    <div
                        id={`${CommonPrefix}panel-highlight`}
                        style={{
                            width: displaySettingRef.current.fixedData.width * window.innerWidth,
                            [highlight.position]: 0,
                        }}
                    />
                )}
            </root.div>
        )
    );
}

/**
 * calculate the width of scroll bar
 * method: create a div element with a scroll bar and calculate the difference between offsetWidth and clientWidth
 * @returns {number} the width of scroll bar
 */
function getScrollbarWidth() {
    let scrollDiv = document.createElement("div");
    scrollDiv.style.cssText =
        "width: 99px; height: 99px; overflow: scroll; position: absolute; top: -9999px;";
    document.documentElement.appendChild(scrollDiv);
    let scrollbarWidth = scrollDiv.offsetWidth - scrollDiv.clientWidth;
    document.documentElement.removeChild(scrollDiv);
    return scrollbarWidth;
}

/**
 * judge whether the current page has a scroll bar
 */
function hasScrollbar() {
    return (
        document.body.scrollHeight > (window.innerHeight || document.documentElement.clientHeight)
    );
}

/**
 * A reducer for source pronouncing state
 * Send message to background to pronounce the translating text.
 */
function sourcePronounce(_, startPronounce) {
    if (startPronounce)
        Messager.send("background", "pronounce", {
            pronouncing: "source",
            text: window.translateResult.originalText,
            language: window.translateResult.sourceLanguage,
            speed: sourceTTSSpeed,
        }).then(() => {
            if (sourceTTSSpeed === "fast") {
                sourceTTSSpeed = "slow";
            } else {
                sourceTTSSpeed = "fast";
            }
        });
    return startPronounce;
}

/**
 * A reducer for target pronouncing state
 */
function targetPronounce(_, startPronounce) {
    if (startPronounce)
        Messager.send("background", "pronounce", {
            pronouncing: "target",
            text: window.translateResult.mainMeaning,
            language: window.translateResult.targetLanguage,
            speed: targetTTSSpeed,
        }).then(() => {
            if (targetTTSSpeed === "fast") {
                targetTTSSpeed = "slow";
            } else {
                targetTTSSpeed = "fast";
            }
        });
    return startPronounce;
}
