"""The blank Gramps 6.0.6 object of every object class (generated: do not edit; HFY-TSK-409).

Written by gramps/scripts/gen-blanks.py under the bundled Gramps, which checks it byte for byte with --check. Each value is
`object_to_dict(Class())`. `hfygramps/blank.py` reads it; standard library only.
"""
import json

BLANKS = json.loads(r'''
{
 "Address": {
  "_class": "Address",
  "citation_list": [],
  "city": "",
  "country": "",
  "county": "",
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "locality": "",
  "note_list": [],
  "phone": "",
  "postal": "",
  "private": false,
  "state": "",
  "street": ""
 },
 "Attribute": {
  "_class": "Attribute",
  "citation_list": [],
  "note_list": [],
  "private": false,
  "type": {
   "_class": "AttributeType",
   "string": "",
   "value": 3
  },
  "value": ""
 },
 "ChildRef": {
  "_class": "ChildRef",
  "citation_list": [],
  "frel": {
   "_class": "ChildRefType",
   "string": "",
   "value": 1
  },
  "mrel": {
   "_class": "ChildRefType",
   "string": "",
   "value": 1
  },
  "note_list": [],
  "private": false,
  "ref": null
 },
 "Citation": {
  "_class": "Citation",
  "attribute_list": [],
  "change": 0,
  "confidence": 2,
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "gramps_id": null,
  "handle": null,
  "media_list": [],
  "note_list": [],
  "page": "",
  "private": false,
  "source_handle": null,
  "tag_list": []
 },
 "Date": {
  "_class": "Date",
  "calendar": 0,
  "dateval": [
   0,
   0,
   0,
   false
  ],
  "format": null,
  "modifier": 0,
  "newyear": 0,
  "quality": 0,
  "sortval": 0,
  "text": ""
 },
 "Event": {
  "_class": "Event",
  "attribute_list": [],
  "change": 0,
  "citation_list": [],
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "description": "",
  "gramps_id": null,
  "handle": null,
  "media_list": [],
  "note_list": [],
  "place": "",
  "private": false,
  "tag_list": [],
  "type": {
   "_class": "EventType",
   "string": "",
   "value": 12
  }
 },
 "EventRef": {
  "_class": "EventRef",
  "attribute_list": [],
  "citation_list": [],
  "note_list": [],
  "private": false,
  "ref": null,
  "role": {
   "_class": "EventRoleType",
   "string": "",
   "value": 1
  }
 },
 "Family": {
  "_class": "Family",
  "attribute_list": [],
  "change": 0,
  "child_ref_list": [],
  "citation_list": [],
  "complete": 0,
  "event_ref_list": [],
  "father_handle": null,
  "gramps_id": null,
  "handle": null,
  "lds_ord_list": [],
  "media_list": [],
  "mother_handle": null,
  "note_list": [],
  "private": false,
  "tag_list": [],
  "type": {
   "_class": "FamilyRelType",
   "string": "",
   "value": 3
  }
 },
 "LdsOrd": {
  "_class": "LdsOrd",
  "citation_list": [],
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "famc": null,
  "note_list": [],
  "place": "",
  "private": false,
  "status": 0,
  "temple": "",
  "type": 0
 },
 "Location": {
  "_class": "Location",
  "city": "",
  "country": "",
  "county": "",
  "locality": "",
  "parish": "",
  "phone": "",
  "postal": "",
  "state": "",
  "street": ""
 },
 "Media": {
  "_class": "Media",
  "attribute_list": [],
  "change": 0,
  "checksum": "",
  "citation_list": [],
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "desc": "",
  "gramps_id": null,
  "handle": null,
  "mime": "",
  "note_list": [],
  "path": "",
  "private": false,
  "tag_list": [],
  "thumb": null
 },
 "MediaRef": {
  "_class": "MediaRef",
  "attribute_list": [],
  "citation_list": [],
  "note_list": [],
  "private": false,
  "rect": null,
  "ref": null
 },
 "Name": {
  "_class": "Name",
  "call": "",
  "citation_list": [],
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "display_as": 0,
  "famnick": "",
  "first_name": "",
  "group_as": "",
  "nick": "",
  "note_list": [],
  "private": false,
  "sort_as": 0,
  "suffix": "",
  "surname_list": [],
  "title": "",
  "type": {
   "_class": "NameType",
   "string": "",
   "value": 2
  }
 },
 "Note": {
  "_class": "Note",
  "change": 0,
  "format": 0,
  "gramps_id": null,
  "handle": null,
  "private": false,
  "tag_list": [],
  "text": {
   "_class": "StyledText",
   "string": "",
   "tags": []
  },
  "type": {
   "_class": "NoteType",
   "string": "",
   "value": 1
  }
 },
 "Person": {
  "_class": "Person",
  "address_list": [],
  "alternate_names": [],
  "attribute_list": [],
  "birth_ref_index": -1,
  "change": 0,
  "citation_list": [],
  "death_ref_index": -1,
  "event_ref_list": [],
  "family_list": [],
  "gender": 2,
  "gramps_id": null,
  "handle": null,
  "lds_ord_list": [],
  "media_list": [],
  "note_list": [],
  "parent_family_list": [],
  "person_ref_list": [],
  "primary_name": {
   "_class": "Name",
   "call": "",
   "citation_list": [],
   "date": {
    "_class": "Date",
    "calendar": 0,
    "dateval": [
     0,
     0,
     0,
     false
    ],
    "format": null,
    "modifier": 0,
    "newyear": 0,
    "quality": 0,
    "sortval": 0,
    "text": ""
   },
   "display_as": 0,
   "famnick": "",
   "first_name": "",
   "group_as": "",
   "nick": "",
   "note_list": [],
   "private": false,
   "sort_as": 0,
   "suffix": "",
   "surname_list": [],
   "title": "",
   "type": {
    "_class": "NameType",
    "string": "",
    "value": 2
   }
  },
  "private": false,
  "tag_list": [],
  "urls": []
 },
 "PersonRef": {
  "_class": "PersonRef",
  "citation_list": [],
  "note_list": [],
  "private": false,
  "ref": null,
  "rel": ""
 },
 "Place": {
  "_class": "Place",
  "alt_loc": [],
  "alt_names": [],
  "change": 0,
  "citation_list": [],
  "code": "",
  "gramps_id": null,
  "handle": null,
  "lat": "",
  "long": "",
  "media_list": [],
  "name": {
   "_class": "PlaceName",
   "date": {
    "_class": "Date",
    "calendar": 0,
    "dateval": [
     0,
     0,
     0,
     false
    ],
    "format": null,
    "modifier": 0,
    "newyear": 0,
    "quality": 0,
    "sortval": 0,
    "text": ""
   },
   "lang": "",
   "value": ""
  },
  "note_list": [],
  "place_type": {
   "_class": "PlaceType",
   "string": "",
   "value": -1
  },
  "placeref_list": [],
  "private": false,
  "tag_list": [],
  "title": "",
  "urls": []
 },
 "PlaceName": {
  "_class": "PlaceName",
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "lang": "",
  "value": ""
 },
 "PlaceRef": {
  "_class": "PlaceRef",
  "date": {
   "_class": "Date",
   "calendar": 0,
   "dateval": [
    0,
    0,
    0,
    false
   ],
   "format": null,
   "modifier": 0,
   "newyear": 0,
   "quality": 0,
   "sortval": 0,
   "text": ""
  },
  "ref": null
 },
 "RepoRef": {
  "_class": "RepoRef",
  "call_number": "",
  "media_type": {
   "_class": "SourceMediaType",
   "string": "",
   "value": 2
  },
  "note_list": [],
  "private": false,
  "ref": null
 },
 "Repository": {
  "_class": "Repository",
  "address_list": [],
  "change": 0,
  "gramps_id": null,
  "handle": null,
  "name": "",
  "note_list": [],
  "private": false,
  "tag_list": [],
  "type": {
   "_class": "RepositoryType",
   "string": "",
   "value": 1
  },
  "urls": []
 },
 "Source": {
  "_class": "Source",
  "abbrev": "",
  "attribute_list": [],
  "author": "",
  "change": 0,
  "gramps_id": null,
  "handle": null,
  "media_list": [],
  "note_list": [],
  "private": false,
  "pubinfo": "",
  "reporef_list": [],
  "tag_list": [],
  "title": ""
 },
 "SrcAttribute": {
  "_class": "SrcAttribute",
  "private": false,
  "type": {
   "_class": "SrcAttributeType",
   "string": "",
   "value": -1
  },
  "value": ""
 },
 "StyledText": {
  "_class": "StyledText",
  "string": "",
  "tags": []
 },
 "StyledTextTag": {
  "_class": "StyledTextTag",
  "name": {
   "_class": "StyledTextTagType",
   "string": "",
   "value": -1
  },
  "ranges": [],
  "value": null
 },
 "Surname": {
  "_class": "Surname",
  "connector": "",
  "origintype": {
   "_class": "NameOriginType",
   "string": "",
   "value": 1
  },
  "prefix": "",
  "primary": true,
  "surname": ""
 },
 "Tag": {
  "_class": "Tag",
  "change": 0,
  "color": "#000000000000",
  "handle": null,
  "name": "",
  "priority": 0
 },
 "Url": {
  "_class": "Url",
  "desc": "",
  "path": "",
  "private": false,
  "type": {
   "_class": "UrlType",
   "string": "",
   "value": -1
  }
 }
}
''')
