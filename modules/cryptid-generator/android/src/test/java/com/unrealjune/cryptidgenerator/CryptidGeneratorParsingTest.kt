package com.unrealjune.cryptidgenerator

import expo.modules.kotlin.exception.CodedException
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The parser is the piece that used to corrupt drawings silently: `org.json` swallows the
 * backslash of any escape it does not recognise, and ASCII cryptids are mostly backslashes.
 */
class CryptidGeneratorParsingTest {
  @Test
  fun `reads the delimited block`() {
    val raw = "NAME: Fog Moth\nART:\n  /\\     /\\\n ((  oo  ))\n  \\\\  ~~  //\nEND"

    val parsed = parseGeneration(raw)

    assertEquals("Fog Moth", parsed["name"])
    assertEquals("  /\\     /\\\n ((  oo  ))\n  \\\\  ~~  //", parsed["sigil"])
  }

  @Test
  fun `keeps every backslash in the art`() {
    val raw = "NAME: Shuck\nART:\n /\\_/\\\n( o.o )\n \\_^_/\nEND"

    val parsed = parseGeneration(raw)

    assertEquals(" /\\_/\\\n( o.o )\n \\_^_/", parsed["sigil"])
  }

  @Test
  fun `tolerates a missing ART marker and a missing END`() {
    val raw = "NAME: Rain Stag\n \\|/ \\|/\n ( oo )"

    val parsed = parseGeneration(raw)

    assertEquals("Rain Stag", parsed["name"])
    assertEquals(" \\|/ \\|/\n ( oo )", parsed["sigil"])
  }

  @Test
  fun `strips markdown around the name and the art`() {
    val raw = "**NAME:** Alley Owl\nART:\n```\n .---.\n( o o )\n```\nEND"

    val parsed = parseGeneration(raw)

    assertEquals("Alley Owl", parsed["name"])
    assertEquals(" .---.\n( o o )", parsed["sigil"])
  }

  @Test
  fun `stops a fenced drawing at its closing fence`() {
    val raw = "NAME: Alley Owl\nART:\n```\n .---.\n( o o )\n```\nHope you like it! :)"

    assertEquals(" .---.\n( o o )", parseGeneration(raw)["sigil"])
  }

  @Test
  fun `keeps doubled and slashed backslashes in the JSON fallback`() {
    val raw = """{"name": "Zigzag", "sigil": " /\/\ \n \\   // "}"""

    assertEquals(" /\\/\\ \n \\\\   // ", parseGeneration(raw)["sigil"])
  }

  @Test
  fun `falls back to JSON without eating unescaped backslashes`() {
    val raw = """{"name": "Lake Thing", "sigil": " .-.\n(\_/)\n /~\ "}"""

    val parsed = parseGeneration(raw)

    assertEquals("Lake Thing", parsed["name"])
    assertEquals(" .-.\n(\\_/)\n /~\\ ", parsed["sigil"])
  }

  @Test
  fun `keeps a truncated JSON drawing instead of discarding it`() {
    val raw = """{"name": "Cut Off", "sigil": " .-.\n( o o"""

    val parsed = parseGeneration(raw)

    assertEquals("Cut Off", parsed["name"])
    assertEquals(" .-.\n( o o", parsed["sigil"])
  }

  @Test(expected = CodedException::class)
  fun `rejects output with no drawing at all`() {
    parseGeneration("I am sorry, I cannot draw that.")
  }
}
