/*
bloom-player-core is responsible for all the behavior of working through a book, but without any UI controls
(other than page turning).
*/
import * as React from "react";
import axios, { AxiosPromise } from "axios";
import Slider from "react-slick";
// tslint:disable:no-submodule-imports (no idea how to import this from root, or do without it)
import "slick-carousel/slick/slick.css";
import "slick-carousel/slick/slick-theme.css";
// This loads some JS right here that is a polyfill for the (otherwise discontinued) scoped-styles html feature
import "style-scoped/scoped"; // maybe use .min.js after debugging?
// tslint:enable:no-submodule-imports
import "./bloom-player.less";
import Narration from "./narration";
import LiteEvent from "./event";
import { Animation } from "./animation";
import { BloomPlayerControls } from "./bloom-player-controls";
import { OldQuestionsConverter } from "./legacyQuizHandling/old-questions";

// BloomPlayer takes the URL of a folder containing a Bloom book. The file name
// is expected to match the folder name. (Enhance: might be better to just take
// the full path to the book. Longer, but removes that assumption.)
// It displays pages from the book and allows them to be turned by dragging.
// On a wide screen, an option may be used to show the next and previous pages
// beside the current one.

interface IProps {
    url: string; // of the bloom book (folder)
    landscape: boolean; // whether viewing as landscape or portrait
    showContextPages?: boolean;
    // ``paused`` allows the parent to control pausing of audio. We expect we may supply
    // a click/touch event callback if needed to support pause-on-touch.
    paused?: boolean;

    // reportBookProperties is called when book loaded enough to determine these properties.
    // This is probably obsolete, since if the player is embedded in a iframe as we currently
    // require, only the containing BloomPlayerControls can make use of it. However, it's just
    // possible we might want it if we end up with rotation-related controls. Note that the
    // same information is made available via postMessage if the control's window has a parent.
    reportBookProperties?: (properties: {
        landscape: boolean;
        canRotate: boolean;
    }) => void;
    // called for initial page and subsequent page changes, passed the slider page
    // (the parent of the .bloom-page, including also the special element that carries
    // all the page styles)
    pageSelected?: (sliderPage: HTMLElement) => void;
    hideNextPrevButtons?: boolean;
}
interface IState {
    pages: string[]; // of the book. First and last are empty in context mode.
    styleRules: string; // concatenated stylesheets the book references or embeds.
    // indicates current page, though typically not corresponding to the page
    // numbers actually on the page. This is an index into pages, and in context
    // mode it's the index of the left context page, not the main page.
    currentSliderIndex: number;
}
export class BloomPlayerCore extends React.Component<IProps, IState> {
    public readonly state: IState = {
        pages: ["loading..."],
        styleRules: "",
        currentSliderIndex: 0
    };

    private sourceUrl: string;

    private narration: Narration;
    private animation: Animation;
    private canRotate: boolean;

    private static currentPage: HTMLElement;

    public componentDidMount() {
        this.componentDidUpdate(this.props);
    }

    // We expect it to show some kind of loading indicator on initial render, then
    // we do this work. For now, won't get a loading indicator if you change the url prop.
    public componentDidUpdate(prevProps: IProps) {
        if (!this.narration) {
            this.narration = new Narration();
            this.narration.PageDurationAvailable = new LiteEvent<HTMLElement>();
            this.animation = new Animation();
            //this.narration.PageNarrationComplete.subscribe();
            this.narration.PageDurationAvailable.subscribe(pageElement => {
                this.animation.HandlePageDurationAvailable(
                    pageElement!,
                    this.narration.PageDuration
                );
            });
        }
        let newSourceUrl = this.props.url;
        // Folder urls often (but not always) end in /. If so, remove it, so we don't get
        // an empty filename or double-slashes in derived URLs.
        // enhance typescript: when we somehow configure a version that knows about
        // endsWith, we can remove this cast.
        if ((newSourceUrl as any).endsWith("/")) {
            newSourceUrl = newSourceUrl.substring(0, newSourceUrl.length - 1);
        }
        if (newSourceUrl !== this.sourceUrl && newSourceUrl) {
            this.sourceUrl = newSourceUrl;
            this.narration.urlPrefix = this.sourceUrl;
            const index = this.sourceUrl.lastIndexOf("/");
            const filename = this.sourceUrl.substring(index + 1);
            // TODO: right now, this takes a url to the folder. Change to a url to the file.
            // Note: In the future, we are thinking of limiting to
            // a few domains (localhost, dev.blorg, blorg).
            const urlOfBookHtmlFile = this.sourceUrl + "/" + filename + ".htm"; // enhance: search directory if name doesn't match?
            axios.get(urlOfBookHtmlFile).then(result => {
                // we *think* this gets garbage collected
                const doc = document.createElement("html"); // TODO: would this work if it was "holderForBook"? JH was tripped up by html, thinking we were going to replace ourselves
                doc.innerHTML = result.data;

                const body = doc.getElementsByTagName("body")[0];
                this.canRotate = body.hasAttribute("data-bfcanrotate"); // expect value allOrientations;bloomReader, should we check?

                this.makeNonEditable(body);

                // This function, the rest of the work we need to do, will be executed after we attempt
                // to retrieve questions.json and either get it and convert it into extra pages,
                // or fail to get it and make no changes.
                const finishUp = () => {
                    // assemble the page content list
                    const pages = doc.getElementsByClassName("bloom-page");
                    const sliderContent: string[] = [];
                    if (this.props.showContextPages) {
                        sliderContent.push(""); // blank page to fill the space left of first.
                    }
                    for (let i = 0; i < pages.length; i++) {
                        const page = pages[i];
                        const landscape = this.forceDevicePageSize(page);
                        // Now we have all the information we need to call reportBookProps if it is set.
                        if (i === 0 && this.props.reportBookProperties) {
                            // Informs containing react controls (in the same frame)
                            this.props.reportBookProperties({
                                landscape,
                                canRotate: this.canRotate
                            });
                            // Informs parent window when in an iframe.
                            if (window.parent) {
                                window.parent.postMessage(
                                    { landscape, canRotate: this.canRotate },
                                    "*"
                                );
                            }
                            // So far there's no way (or need) to inform whatever set up a WebView.
                        }

                        this.fixRelativeUrls(page);

                        sliderContent.push(page.outerHTML);
                    }
                    if (this.props.showContextPages) {
                        sliderContent.push(""); // blank page to fill the space right of last.
                    }

                    this.assembleStyleSheets(doc);
                    this.setState({ pages: sliderContent });
                    // A pause hopefully allows the document to become visible before we
                    // start playing any audio or movement on the first page.
                    // Also gives time for the first page
                    // element to actually get created in the document.
                    // Note: typically in Chrome we won't actually start playing, because
                    // of a rule that the user must interact with the document first.
                    window.setTimeout(() => {
                        this.setIndex(0);
                        this.showingPage(0);
                    }, 500);
                };

                const firstPage = doc.getElementsByClassName("bloom-page")[0];
                let pageClass = "Device16x9Portrait";
                if (firstPage) {
                    pageClass = BloomPlayerCore.getPageSizeClass(firstPage);
                }

                const urlOfQuestionsFile = this.sourceUrl + "/questions.json";
                axios
                    .get(urlOfQuestionsFile)
                    .then(qfResult => {
                        const newPages = OldQuestionsConverter.convert(
                            qfResult.data,
                            pageClass
                        );
                        const firstBackMatterPage = body.getElementsByClassName(
                            "bloom-backMatter"
                        )[0];
                        for (let i = 0; i < newPages.length; i++) {
                            // insertAdjacentElement is tempting, but not in FF45.
                            firstBackMatterPage.parentElement!.insertBefore(
                                newPages[i],
                                firstBackMatterPage
                            );
                        }
                        finishUp();
                    })
                    .catch(() => finishUp());
            });
        }
        if (prevProps.landscape !== this.props.landscape) {
            // may need to show or hide animation
            this.setIndex(this.state.currentSliderIndex);
            this.showingPage(this.state.currentSliderIndex);
        }
        if (this.props.paused) {
            this.narration.pause();
        } else {
            this.narration.play();
        }
    }

    private makeNonEditable(body: HTMLBodyElement): void {
        // This is a preview, it's distracting to have it be editable.
        // (Should not occur in .bloomd, but might in books direct from BL.)
        const editable = document.evaluate(
            ".//*[@contenteditable]",
            body,
            null,
            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
            null
        );
        for (let iedit = 0; iedit < editable.snapshotLength; iedit++) {
            (editable.snapshotItem(iedit) as HTMLElement).removeAttribute(
                "contenteditable"
            );
        }
    }

    private forceDevicePageSize(page: Element): boolean {
        return BloomPlayerCore.forceDevicePageSize(
            page,
            this.canRotate,
            this.props.landscape
        );
    }

    public static getPageSizeClass(page: Element): string {
        const classAttr = page.getAttribute("class") || "";
        const matches = classAttr.match(/\b\S*?(Portrait|Landscape)\b/);
        if (matches && matches.length) {
            return matches[0];
        } else {
            return "";
        }
    }

    // Force size class to be one of the device classes
    // return true if we determine that the book is landscape
    public static forceDevicePageSize(
        page: Element,
        bookCanRotate: boolean,
        showLandscape: boolean
    ): boolean {
        let landscape = false;
        const sizeClass = this.getPageSizeClass(page);
        if (sizeClass) {
            landscape = bookCanRotate
                ? showLandscape
                : (sizeClass as any).endsWith("Landscape");
            const desiredClass = landscape
                ? "Device16x9Landscape"
                : "Device16x9Portrait";
            if (sizeClass !== desiredClass) {
                page.classList.remove(sizeClass);
                page.classList.add(desiredClass);
            }
        }
        return landscape;
    }

    // urls of images and videos and audio need to be made
    // relative to the original book folder, not the page we are embedding them into.
    private fixRelativeUrls(page: Element) {
        const srcElts = document.evaluate(
            ".//*[@src]",
            page,
            null,
            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
            null
        );

        for (let j = 0; j < srcElts.snapshotLength; j++) {
            const item = srcElts.snapshotItem(j) as HTMLElement;
            if (!item) {
                continue;
            }
            const srcName = item.getAttribute("src");
            const srcPath = this.fullUrl(srcName);
            item.setAttribute("src", srcPath);
        }

        // now we need to fix elements with attributes like this:
        // style="background-image:url('AOR_10AW.png')"
        const bgSrcElts = document.evaluate(
            ".//*[@style]",
            page,
            null,
            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
            null
        );

        for (let j = 0; j < bgSrcElts.snapshotLength; j++) {
            const item = bgSrcElts.snapshotItem(j) as HTMLElement;
            if (!item) {
                continue;
            }
            const style = item.getAttribute("style") || ""; // actually we know it has style, but make lint happy
            const match = /background-image:url\(['"](.*?)['"]/.exec(style);
            if (!match) {
                continue;
            }
            const newUrl = this.fullUrl(match[1]);
            const newStyle = style.replace(
                /background-image:url\(['"](.*?)['"]/,
                "background-image:url('" + newUrl + "'"
            );
            item.setAttribute("style", newStyle);
        }
    }

    // Assemble all the style rules from all the stylesheets the book contains or references.
    // When we finish (not before this method returns), the result will be set as
    // our state.styles with setState().
    private assembleStyleSheets(doc: HTMLHtmlElement) {
        const linkElts = document.evaluate(
            ".//link[@href and @type='text/css']",
            doc,
            null,
            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
            null
        );
        const promises: Array<AxiosPromise<any>> = [];
        for (let i = 0; i < linkElts.snapshotLength; i++) {
            const link = linkElts.snapshotItem(i) as HTMLElement;
            const href = link.getAttribute("href");
            const fullHref = this.fullUrl(href);
            promises.push(axios.get(fullHref));
        }
        axios
            .all(
                promises.map(p =>
                    p.catch(
                        // if one stylesheet doesn't exist or whatever, keep going
                        () => undefined
                    )
                )
            )
            .then(results => {
                let combinedStyle = "";

                // start with embedded styles (typically before links in a bloom doc...)
                const styleElts = document.evaluate(
                    ".//style[@type='text/css']",
                    doc,
                    null,
                    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
                    null
                );
                for (let k = 0; k < styleElts.snapshotLength; k++) {
                    const styleElt = styleElts.snapshotItem(k) as HTMLElement;
                    combinedStyle += styleElt.innerText;
                }

                // then add the stylesheet contents we just retrieved
                results.forEach(result => {
                    if (result && result.data) {
                        combinedStyle += result.data;
                    }
                });
                this.setState({ styleRules: combinedStyle });
                BloomPlayerControls.pageStylesInstalled = true;
            });
    }

    private fullUrl(url: string | null): string {
        // Enhance: possibly we should only do this if we somehow determine it is a relative URL?
        // But the things we apply it to always are, in bloom books.
        return this.sourceUrl + "/" + url;
    }

    private slider: Slider | null;
    private rootDiv: HTMLElement | null;

    public getRootDiv(): HTMLElement | null {
        return this.rootDiv;
    }

    public render() {
        // multiple classes help make rules more specific than those in the book's stylesheet
        // (which benefit from an extra attribute item like __scoped_N)
        // It would be nice to use an ID but we don't want to assume there is
        // only one of these components on a page.
        return (
            <div
                className={
                    "bloomPlayer" +
                    (this.props.hideNextPrevButtons
                        ? " hideNextPrevButtons"
                        : "")
                }
                ref={bloomplayer => (this.rootDiv = bloomplayer)}
            >
                <Slider
                    className="pageSlider"
                    ref={slider => (this.slider = slider)}
                    slidesToShow={this.props.showContextPages ? 3 : 1}
                    infinite={false}
                    dots={this.props.showContextPages}
                    beforeChange={(current, next) => this.setIndex(next)}
                    afterChange={current => this.showingPage(current)}
                >
                    {this.state.pages.map((slide, index) => {
                        return (
                            <div
                                key={slide}
                                className={
                                    "page-preview-slide" +
                                    this.getSlideClass(index)
                                }
                            >
                                <style scoped={true}>
                                    {this.state.styleRules}
                                </style>
                                <div
                                    className="actual-page-preview"
                                    dangerouslySetInnerHTML={{ __html: slide }}
                                    ref={div => this.pageLoaded(div)}
                                />
                            </div>
                        );
                    })}
                </Slider>
            </div>
        );
    }

    private pageLoaded(div: HTMLDivElement | null): void {
        // When a page loads, if it is an interactive page we want to execute any scripts embedded in it.
        // This is potentially dangerous, so we make it less likely to happen through random attacks
        // by only doing it in pages that are explicitly marked as bloom interactive pages.
        if (
            div &&
            div.firstElementChild &&
            div.firstElementChild.classList.contains("bloom-interactive-page")
        ) {
            const scripts = div.getElementsByTagName("script");
            for (let i = 0; i < scripts.length; i++) {
                const script = scripts[i];
                const src = script.getAttribute("src");
                if (!src) {
                    // enhance: possibly window.eval(script.innerText?)
                    // But we consider embedding such scripts in Bloom
                    // unworkable, because our XHTML conversion mangles angle brackets.
                    continue;
                }

                // It's quite reasonable for this file to be missing in the book folder itself.
                // If so, the reader supplies its own version. This annotation is helpful when
                // previewing books served by Bloom itself, preventing "file not found" yellow boxes.
                const possiblyOptionalSrc = src.endsWith(
                    "/simpleComprehensionQuiz.js"
                )
                    ? src + "?optional=true"
                    : src;
                // This would be highly dangerous in most contexts. It is one of the reasons
                // we insist that bloom-player should live in its own iframe, protecting the rest
                // of the page from things this eval might do.
                axios
                    .get(possiblyOptionalSrc)
                    // tslint:disable-next-line: no-eval
                    .then(result => eval(result.data))
                    .catch(() => {
                        if (src.endsWith("/simpleComprehensionQuiz.js")) {
                            // Probably we generated a replacement page for old-style json comprehension questions.
                            // The required javascript is not in the book folder, so retrieve our own version.
                            // We expect this to be in the same place as the root html file, so we strip the file
                            // name of our url (without params).
                            const href =
                                window.location.protocol +
                                "//" +
                                window.location.host +
                                window.location.pathname;
                            const lastSlash = href.lastIndexOf("/");
                            const folder = href.substring(0, lastSlash);
                            const tryForQuiz =
                                folder + "/simpleComprehensionQuiz.js";
                            axios
                                .get(tryForQuiz)
                                .then(result => {
                                    // tslint:disable-next-line: no-eval
                                    eval(result.data);
                                })
                                .catch(error => {
                                    console.log(error);
                                });
                            // If we don't get it there, not much we can do.
                        }
                    });
            }
        }
    }

    // Get a class to apply to a particular slide. This is used to apply the
    // contextPage class to the slides before and after the current one.
    private getSlideClass(itemIndex: number): string {
        if (!this.props.showContextPages) {
            return "";
        }
        if (
            itemIndex === this.state.currentSliderIndex ||
            itemIndex === this.state.currentSliderIndex + 2
        ) {
            return "contextPage";
        }
        return "";
    }

    // Called from beforeChange
    // - makes an early change to state.currentSliderIndex, which triggers some
    // class changes to animate the page sizing/shading in 3-page mode
    // - may need to force the page layout class to match the current button
    // setting, before we start to slide it into view
    // - if we're animating motion, need to get the page into the start state
    // before we slide it in
    private setIndex(index: number) {
        this.setState({ currentSliderIndex: index });
        const { slider: _, page: bloomPage } = this.getPageAtSliderIndex(index);
        if (bloomPage) {
            // If the book can rotate, the page size class in the preview
            // may not match the one we need for the current state of the orientation buttons.
            if (this.canRotate) {
                this.forceDevicePageSize(bloomPage);
            }
            this.animation.HandlePageBeforeVisible(bloomPage);
        }
    }

    private getPageAtSliderIndex(
        index: number
    ): { slider: HTMLElement; page: HTMLElement | null } {
        const sliderPage = document.querySelectorAll(
            ".slick-slide[data-index='" +
                (index + (this.props.showContextPages ? 1 : 0)) +
                "'"
        )[0] as HTMLElement;
        if (!sliderPage) {
            return { slider: sliderPage, page: null }; // unexpected
        }
        const bloomPage = sliderPage.getElementsByClassName(
            "bloom-page"
        )[0] as HTMLElement;
        return { slider: sliderPage, page: bloomPage };
    }

    public static getCurrentPage(): HTMLElement {
        return BloomPlayerCore.currentPage;
    }

    // Called from afterChange, starts narration, etc.
    private showingPage(index: number): void {
        const {
            slider: sliderPage,
            page: bloomPage
        } = this.getPageAtSliderIndex(index);
        if (!bloomPage) {
            return; // blank initial or final page?
        }
        BloomPlayerCore.currentPage = bloomPage;
        if (this.canRotate) {
            this.forceDevicePageSize(bloomPage);
        }
        // When we have computed it, this will raise PageDurationComplete,
        // which calls an animation method to start the image animation.
        this.narration.computeDuration(bloomPage);
        this.narration.playAllSentences(bloomPage);
        if (this.props.pageSelected) {
            this.props.pageSelected(sliderPage);
        }
        if (
            bloomPage &&
            Animation.pageHasAnimation(bloomPage as HTMLDivElement)
        ) {
            this.animation.HandlePageBeforeVisible(bloomPage);
        }
        this.animation.HandlePageVisible(bloomPage);
    }
}
