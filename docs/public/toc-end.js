// "On this page" marks the section whose heading is at the top of the window. Short last
// sections never reach the top, so at the end of the page the mark stopped halfway: there, it
// moves to the last section. It runs after Starlight's own update of the mark.
let timer;
addEventListener(
  "scroll",
  () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 8;
      if (!atEnd) return;
      for (const toc of document.querySelectorAll("starlight-toc, mobile-starlight-toc")) {
        const links = toc.querySelectorAll("a");
        if (links.length === 0) continue;
        for (const a of links) a.removeAttribute("aria-current");
        links[links.length - 1].setAttribute("aria-current", "true");
      }
    }, 120);
  },
  { passive: true },
);
