# HFY-PLN-002 requirement trace list (derived from io's verbatim intent, DOC-2CFAE07B546C)

Every design section and task must cite the requirement IDs it covers. Every ID must be covered by at least one task.

## Photos and comments
- R-01: Comments support attached photos.
- R-02: An admin can "graduate" a photo attached to a comment into a record (Gramps) photo.

## North star: sync and source of truth
- R-03: The data flow becomes bi-directional, Gramps <-> website, and the cloud data backend becomes the source of truth.
- R-04: io's local Gramps desktop consumes cloud updates in a well-engineered, highly robust way, with extensive error handling.
- R-05: The Gramps owner (io) can edit directly in Gramps and push to the live cloud database.

## Proposals and editing
- R-06: Non-admin users can "propose" changes to all database record metadata, valid values only.
- R-07: Only admins can approve proposals.
- R-08: Gramps-parity editing in the PWA covers essentially everything Gramps can edit out of the box.
- R-09: Signed-in users can edit all of their own information directly, except DOB, first, middle and last name, and parents, which must be proposals.

## Notifications and subscriptions
- R-10: Admins are notified of proposals.
- R-11: Users are notified when their proposals are accepted and when their own record data is updated.
- R-12: Users can subscribe to any other family member's record and get notified when it is updated.
- R-13: Notifications kit upgrade:
  - in-app notifications
  - a list of all unread notifications
  - mark read individually or in bulk
  - optimal UX on every device type and viewport

## Homepage and About
- R-14: The homepage gets an "On this day" feature, styled per the guidelines: celebratory for happy events and tempered commemoration for deaths.
- R-15: The signed-in /about/ page ends with a call to action: the story transitions into inspiring users to browse records, add what's missing, fix what's wrong and upload media.

## Profile links
- R-16: A new "links" section on the user's profile, augmenting the Gramps data, holds facebook, instagram, snapchat, tiktok, linktree, website and linkedin.
- R-17: The website field rejects URLs from any of the supported sites.

## Privacy guards
- R-18: Universal rule: personal contact information is never stored or exposed. Submissions containing a phone number or address get an error until the user removes it.
- R-19: DOBs are not stored in the cloud (Gramps keeps them). The sync explicitly refuses DOB data going to the cloud.

## Navigation
- R-20: The nav item that opens your own profile is labelled "Me". It was "Family".
- R-21: A gear icon links to settings, the old "Me" destination.

## Visualization and sign-up
- R-22: A state-of-the-art visualization overhaul that uses desktop space to tell the family story and works on mobile without becoming tiny images. It is research-first; io runs a claude.ai research prompt.
- R-23: A sign-up (access request) flow for people who heard about the site by word of mouth. They must provide at least sections 1 and 2 of the Legacy Form.

## Relationships
- R-24: Relationship proposals are an interactive experience that mimics adding relationships in Gramps, designed for older, non-technical users:
  - say who your children are
  - children joining select existing records as their parents
  - add a spouse

## Contributions and gamification
- R-25: The feed shows "X contributions in the past Y ZZZZ", dynamic on volumes and trends.
- R-26: Each record shows how many contributions that person has made.
- R-27: Each family member's page gets a contributions feed. On wide viewports it sits to the right of comments, split 50/50; on small screens it stacks below.
- R-28: Each section (stories, comments, contributions) has a height limit on what is downloaded and rendered on load, with pagination for "older …".

## Image tagging
- R-29: Gramps image tags are surfaced. Hovering a tagged person in a photo shows their name.
- R-30: Below each tagged photo is a list of names. Hovering a name shows the tag data captured in Gramps.
- R-31: The site duplicates the Gramps tagging data architecture so that site tagging is compatible with bi-directional sync back to Gramps.

## Moderation
- R-32: Signed-in admins see moderation options on stories, posts, photos and comments:
  - hide the item
  - add a comment that is sent to the user as a notification, requesting an update before the item becomes visible, or asking a question

## Webchat (@io-kit/chat)
- R-33: Webchat is built as an io-kit package first, then installed. It obsessively imitates the original Gmail chat (pre-Google+) UX and functionality; simple and basic is better.
- R-34: Live chat is text only: text and emoji. No reactions, photos, GIFs or attachments.
- R-35: Messages disappear after 30 days but are stored on the server.
- R-36: There are direct chats and group chats. Anyone can start either by picking users from an easy search.
- R-37: Online status shows on profiles, in the chat's family section, and in every direct and group chat the user is in.
- R-38: Group chats:
  - The creator can name the group.
  - A group is private (only the creator invites) or open (any member can invite any member).
  - Members can leave at any time but must be invited back.
  - Members who join later see only messages from that point on.
- R-39: Direct-chat pacing: when only one person is online, only one message may be sent at a time. Both must be online for consecutive sends without a reply.
- R-40: All chats have typing indicators; group chats show several people typing.
- R-41: No bells and whistles. Stability, low latency and simple, intuitive UX come first.

## Sign-up form source
- R-42: The Legacy Form (Google Form), sections 1–2, is the minimum sign-up data set. Its full structure is in Appendix A of DOC-2CFAE07B546C.

## Implicit, derived from discovery (not io's words; flagged as derived)
- D-01: Fix the live privacy leak. The live person JSON carries a day-precise date.sortValue for 1 living person's birth (and 2 deceased people's dates). That violates R-19.
- D-02: Fix the export defects that would corrupt a round trip:
  - notes export empty (Gramps 6 text.string)
  - event types are lost
  - media regions are dropped
  - family type, child frel/mrel and family events are not exported
- D-03: Real family data sits untracked in old Dropbox git checkouts. Protect it from an accidental commit with gitignore rules.
