"""The /privacy/ and /terms/ pages carry the io-approved privacy and terms amendment (HFY-TSK-239, privacy-terms-publish).

The pages checked are the deployable output in 11ty/. The approved text is docs/drafts/privacy-terms-2026-10-update.md, approved
under Q8 (Q2-07) and published before any flip it covers (BRD2 D2-31, 10.2 item 5). Each required section pins sentences of
that text; a pinned sentence must appear in the draft, so this test can only hold the pages to approved wording, and in the
page's visible text. Run by scripts/infra/test/run.sh (CI), or alone:
python3 -m unittest scripts/infra/test/test_privacy_terms_pages.py
"""
import html.parser
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
DRAFT = ROOT / "docs" / "drafts" / "privacy-terms-2026-10-update.md"
PAGES = {"privacy": ROOT / "11ty" / "privacy" / "index.html", "terms": ROOT / "11ty" / "terms" / "index.html"}
APPROVAL = 'Approved by io under Q8 ("all approved. proceed."), 2026-10-13; fact-checked per P2-R24/P2-R28.'
LAST_UPDATED = "Last updated: October 13, 2026"
CONTACT = "info [@] harrisonfamily [DOT] us"

# (section the amendment must cover, page, sentences of the approved text that state it)
REQUIRED = [
    ("suggested changes", "privacy", [
        "You can suggest a change to a family page, for example a name, a date or a parent.",
        "A suggestion waits, with no time limit, until an admin approves or declines it.",
        "Suggestions are kept after the decision too, including declined ones and ones you take back; you can ask for one to be removed (section 7).",
    ]),
    ("who can see suggested changes", "privacy", [
        "Only you, the admins, and family members whose own page it would change can see it, its notes and its comments.",
    ]),
    ("inbox retention: unread kept until read, then 90 days after read", "privacy", [
        "Notifications in your inbox (the bell) are kept until you read them, then for 90 days after you read them, and are then deleted automatically.",
    ]),
    ("moderation", "privacy", [
        "An admin can hide a post, comment or photo, ask you to change it, or ask you a question about it.",
        "You'll see your item with the admin's note, which only you and the admins can see;",
        "Every moderation step is recorded (who, when, what);",
    ]),
    ("moderation (terms)", "terms", [
        "Family moderators can remove posts or comments that break these terms.",
        "Moderators can hide anything you post, ask you to change it, or ask you about it;",
    ]),
    ("contribution counts", "privacy", [
        "The site counts what you add.",
        "Only signed-in family members see counts.",
    ]),
    ("photo graduation: photos added to a family page", "privacy", [
        "An admin can add a photo from a comment to a person's photos on their family page.",
        "Photos that carry a location, or that a moderator has hidden, can't be added.",
    ]),
    ("photo graduation (terms)", "terms", [
        "Approved suggestions, and photos an admin adds from a comment to a family page, become part of the family record and are kept with it.",
    ]),
    ("photos with location data refused", "privacy", [
        "When you add a photo to a post or comment, your browser re-saves it before upload, which removes hidden details such as where it was taken.",
        "The server checks again and refuses any photo that still carries a location.",
    ]),
    ("profile links", "privacy", [
        "You can add links to your public profiles on Facebook, Instagram, Snapchat, TikTok, Linktree and LinkedIn, and to one website.",
        "Links stay on the website only (they're not copied into the family tree) and are kept until you remove them.",
    ]),
    ("access requests", "privacy", [
        "On the join page you give your email and prove it's yours with a 6-digit code,",
        "We keep the code for 15 minutes; the one-time pass it gives you for 60 minutes or until it's used; a request with no decision for 90 days; and a decided request for 30 days after the decision.",
    ]),
    ("access requests (terms)", "terms", [
        "Anyone can ask to join on the join page, and an admin approves each request.",
        "To join, ask on the join page. An admin checks with you outside the site before approving.",
    ]),
    ("chat", "privacy", [
        "Chat messages and group names are stored by Cloudflare, which runs chat for us as a processor",
        "You can see the last 30 days of a chat; older messages disappear from every screen.",
        "The site keeps messages with no end date,",
        "Chat notifications never include the message.",
        "Chat messages are also stored by Cloudflare (3.13).",
    ]),
    ("presence, the exact sentence", "privacy", [
        "while you have the site open, every family member can see that you are online or idle, on your page and in chat; there is no invisible mode",
    ]),
    ("who has an account is visible to members", "privacy", [
        "Chat lists every relative who has an account (by name, never by email), so family members can see who has joined.",
    ]),
    ("presence and accounts (terms)", "terms", [
        "While you have the site open, family members can see that you're online or idle, and who has an account.",
    ]),
    ("Turnstile on the join page", "privacy", [
        "Cloudflare Turnstile checks that you're a person and not a bot; it loads on the join page only.",
        "runs Turnstile on the join page (3.12).",
    ]),
    ("dates per Q2-04b", "privacy", [
        "Birthdays show the year only, for everyone.",
        "For other events, such as deaths, weddings and moves, family members see only the year; admins see the full date, and so do you on events that are yours alone.",
        "If you edit a date that shows only its year, the day and month already stored stay as they were.",
    ]),
    ("removal from the cloud, with the 35-day backup tail", "privacy", [
        "To have something removed from the site and its cloud storage (a detail on a family page, a suggestion, a chat message or a photo),",
        "The admin can remove it from every copy we keep in the cloud: the change history, saved snapshots, the chat copy and stored photos.",
        "Our database's automatic backups go back 35 days, so a removed item can stay in those backups for up to 35 days before they age out.",
        "Ask for a suggestion, a chat message or a photo you added to be removed from the cloud (section 7).",
    ]),
]

# The subsections of privacy section 3, in order: the approved section names, the page's heading case.
PRIVACY_H3 = [
    "3.1 From Sign-In", "3.2 From Site Interaction", "3.3 From Family Data and What You Add", "3.4 Notifications",
    "3.5 What the Site Keeps Out", "3.6 Suggested Changes", "3.7 Dates on Family Pages", "3.8 Photos and Location",
    "3.9 Photos Added to a Family Page", "3.10 Contribution Counts", "3.11 Profile Links", "3.12 Asking to Join", "3.13 Chat",
    "3.14 Online Status and Accounts", "3.15 Moderation",
]

# Statements the amendment replaced: none may come back with an Eleventy refresh.
RETIRED = {
    "privacy": [
        "Not stored permanently", "Authenticate session locally in your browser", "Stored in static JSON on AWS S3",
        "client-side token validation", "Authentication data is stored only in your browser session",
        "Accounts for minors are managed by their guardians", "whitelisted", "read-only export of Gramps records",
        "ETL scripts operate in read-only mode", "Family data persists indefinitely", "From Google Sign-In",
        "All data is stored and processed in the United States", "which stores static site and data assets", "[D0T]",
    ],
    "terms": [
        "invitation-only", "whitelist", "Attempt to bypass Google Sign-In", "Google Sign-In is used only for authentication",
        "stored in static form on AWS S3", "[D0T]",
    ],
}


class _PageText(html.parser.HTMLParser):
    """The visible text of <main>, whitespace-collapsed, and its h2/h3 headings."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0  # inside <main>
        self.skip = 0  # inside <script> or <style>
        self.heading = None
        self.chunks, self.headings = [], []

    def handle_starttag(self, tag, attrs):
        if tag == "main":
            self.depth += 1
        elif tag in ("script", "style"):
            self.skip += 1
        elif tag in ("h2", "h3") and self.depth:
            self.heading = (tag, [])

    def handle_endtag(self, tag):
        if tag == "main":
            self.depth -= 1
        elif tag in ("script", "style"):
            self.skip -= 1
        elif self.heading and tag == self.heading[0]:
            self.headings.append((tag, squash("".join(self.heading[1]))))
            self.heading = None

    def handle_data(self, data):
        if self.depth and not self.skip:
            self.chunks.append(data)
            if self.heading:
                self.heading[1].append(data)


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def read_page(name):
    parser = _PageText()
    parser.feed(PAGES[name].read_text(encoding="utf-8"))
    parser.close()
    return squash(" ".join(parser.chunks)), parser.headings


class PrivacyTermsPages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.draft = squash(DRAFT.read_text(encoding="utf-8"))
        cls.pages = {name: read_page(name) for name in PAGES}

    def test_the_draft_carries_the_dated_approval(self):
        self.assertIn(APPROVAL, self.draft)
        first = DRAFT.read_text(encoding="utf-8").splitlines()[0]
        self.assertNotRegex(first, r"\bfor [A-Z]'s approval", "line 1 names an initial")

    def test_each_required_section_is_present(self):
        for section, page, sentences in REQUIRED:
            text = self.pages[page][0]
            for sentence in sentences:
                with self.subTest(section=section, page=page, sentence=sentence[:60]):
                    self.assertIn(sentence, self.draft, "pinned wording is not in the approved text")
                    self.assertIn(sentence, text)

    def test_privacy_section_3_lists_every_subsection_in_order(self):
        h3 = [title for tag, title in self.pages["privacy"][1] if tag == "h3"]
        self.assertEqual(h3, PRIVACY_H3)

    def test_last_updated_and_contact_line(self):
        for name in PAGES:
            with self.subTest(page=name):
                text = self.pages[name][0]
                self.assertIn(f"{LAST_UPDATED} · Contact: {CONTACT}", text)
                self.assertNotIn("November 6, 2025", text)

    def test_replaced_statements_are_gone(self):
        for name, phrases in RETIRED.items():
            text = self.pages[name][0]
            for phrase in phrases:
                with self.subTest(page=name, phrase=phrase):
                    self.assertNotIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
