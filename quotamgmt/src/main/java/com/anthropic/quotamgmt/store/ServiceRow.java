package com.anthropic.quotamgmt.store;

/** A row of the {@code service} registry (design/quotamgmt.md §3.7, §4.1). */
public record ServiceRow(String serviceName, String displayName, String owner) {
}
