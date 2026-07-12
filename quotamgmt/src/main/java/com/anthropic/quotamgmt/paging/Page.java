package com.anthropic.quotamgmt.paging;

import java.util.List;

/** A page of results plus the opaque cursor for the next page ("" if last). */
public record Page<T>(List<T> items, String nextPageToken) {
}
